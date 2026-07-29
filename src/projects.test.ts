import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { enableEvolutionLoop, runEvolutionLoop } from "./evolution-loop";
import {
  executionMachineStateProjectKey,
  facultAiEvolutionLoopLockPath,
  facultAiEvolutionReviewDir,
  facultAiGraphPath,
  facultAiIndexPath,
  facultAiReconciliationLockPath,
  facultAiReconciliationReviewDir,
  facultAiWritebackReviewDir,
  facultConfigPath,
  facultLocalStateRoot,
  facultMachineStateDir,
  legacyMachineStateProjectKey,
  pathsPhysicallyEquivalent,
} from "./paths";
import {
  applyProjectEnrollment,
  buildProjectsStatus,
  discoverProjects,
  planProjectEnrollment,
  projectCommand,
  resolveRepositoryExecutionIdentity,
  resolveRepositoryIdentity,
  rollbackProjectEnrollment,
} from "./projects";
import { reconcileSources } from "./reconciliation";
import {
  normalizeRepositoryRemote,
  repositoryPathComparisonKey,
} from "./repository-identity";
import { gitEnvironmentForRepository } from "./util/git-environment";

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

async function pathEntryExists(pathValue: string): Promise<boolean> {
  try {
    await lstat(pathValue);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function gitCheckIgnoreExitCode(args: {
  homeDir: string;
  path: string;
  repoDir: string;
}): Promise<number> {
  const process = Bun.spawn({
    cmd: ["git", "check-ignore", "--no-index", args.path],
    cwd: args.repoDir,
    env: gitEnvironmentForRepository({
      isolatedHome: args.homeDir,
      repoDir: args.repoDir,
    }),
    stderr: "pipe",
    stdout: "pipe",
  });
  return await process.exited;
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

  it("propagates corrupt Git candidates instead of reporting complete discovery", async () => {
    const { root, home } = await makeFixture();
    const portfolio = join(root, "portfolio");
    const healthy = join(portfolio, "healthy");
    const abandoned = join(portfolio, "abandoned");
    await createRepository({ path: healthy, home });
    await mkdir(abandoned, { recursive: true });
    await writeFile(
      join(abandoned, ".git"),
      "gitdir: ../missing-worktree-git-dir\n",
      "utf8"
    );

    await expect(
      discoverProjects({
        roots: [portfolio],
        homeDir: home,
        maxVisits: 100,
        maxResults: 10,
      })
    ).rejects.toThrow("Git repository inspection failed");
  });

  it("rejects missing explicit roots instead of reporting complete empty discovery", async () => {
    const { root, home } = await makeFixture();
    await expect(
      discoverProjects({
        roots: [join(root, "missing")],
        homeDir: home,
      })
    ).rejects.toThrow();
  });

  it("propagates repository inspection failures instead of reporting an empty inventory", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const registryPath = plan.machineLocalWrites[0]?.path;
    if (!registryPath) {
      throw new Error("Expected a machine-local project registry path");
    }
    await mkdir(dirname(registryPath), { recursive: true });
    for (const content of ["{", ""]) {
      await writeFile(registryPath, content, "utf8");
      await expect(
        discoverProjects({
          roots: [repo],
          homeDir: home,
        })
      ).rejects.toThrow("Project registry is invalid");
      expect(await readFile(registryPath, "utf8")).toBe(content);
    }
  });

  it("reports worktree cleanliness as unknown when Git status fails", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    await rm(join(repo, ".git", "index"));
    await mkdir(join(repo, ".git", "index"));

    const discovery = await discoverProjects({
      roots: [repo],
      homeDir: home,
    });
    expect(discovery.projects).toHaveLength(1);
    expect(discovery.projects[0]?.dirty).toBeNull();

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    expect(plan.worktree.dirty).toBeNull();
  });

  it("correlates duplicate clones and worktrees by portable identity", async () => {
    const { root, home } = await makeFixture();
    const source = join(root, "source");
    const clone = join(root, "clone");
    const worktree = join(root, "worktree");
    await createRepository({ path: source, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/portable-project.git",
      ],
      repoDir: source,
      homeDir: home,
      cwd: source,
    });
    await runFixtureGit({
      argv: ["clone", source, clone],
      repoDir: clone,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/portable-project.git",
      ],
      repoDir: clone,
      homeDir: home,
      cwd: clone,
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
    const [before, executionBefore] = await Promise.all([
      resolveRepositoryIdentity(initial),
      resolveRepositoryExecutionIdentity(initial),
    ]);

    await rename(initial, renamed);
    const [after, executionAfter] = await Promise.all([
      resolveRepositoryIdentity(renamed),
      resolveRepositoryExecutionIdentity(renamed),
    ]);

    expect(after.id).toBe(before.id);
    expect(executionAfter).toEqual(executionBefore);
    expect(after.kind).toBe("git-common-dir");
    expect(after.stability).toBe("machine-local");
  });

  it("preserves a linked worktree execution identity when Git moves it", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const initial = join(root, "worktree-before");
    const moved = join(root, "worktree-after");
    await createRepository({ path: repo, home });
    await runFixtureGit({
      argv: ["worktree", "add", "-b", "move-worktree", initial],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const [repoExecution, before] = await Promise.all([
      resolveRepositoryExecutionIdentity(repo),
      resolveRepositoryExecutionIdentity(initial),
    ]);

    await runFixtureGit({
      argv: ["worktree", "move", initial, moved],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const after = await resolveRepositoryExecutionIdentity(moved);

    expect(after).toEqual(before);
    expect(after.id).not.toBe(repoExecution.id);
  });

  it("preserves execution identity when a separate-Git-directory checkout moves", async () => {
    const { root, home } = await makeFixture();
    const gitDir = join(root, "repository.git");
    const initial = join(root, "checkout-before");
    const moved = join(root, "checkout-after");
    await runFixtureGit({
      argv: ["init", "-b", "main", `--separate-git-dir=${gitDir}`, initial],
      repoDir: initial,
      homeDir: home,
      cwd: root,
    });
    await writeFile(join(initial, "README.md"), "# Fixture\n", "utf8");
    await runFixtureGit({
      argv: ["add", "README.md"],
      repoDir: initial,
      homeDir: home,
      cwd: initial,
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
      repoDir: initial,
      homeDir: home,
      cwd: initial,
    });
    const before = await resolveRepositoryExecutionIdentity(initial);

    await rename(initial, moved);
    const after = await resolveRepositoryExecutionIdentity(moved);

    expect(after).toEqual(before);
  });

  it("isolates a checkout that points at another repository's Git directory", async () => {
    const { root, home } = await makeFixture();
    const victim = join(root, "victim");
    const alias = join(root, "alias");
    await createRepository({ path: victim, home });
    await mkdir(alias, { recursive: true });
    await writeFile(
      join(alias, ".git"),
      `gitdir: ${join(victim, ".git")}\n`,
      "utf8"
    );

    const [victimExecution, aliasExecution] = await Promise.all([
      resolveRepositoryExecutionIdentity(victim),
      resolveRepositoryExecutionIdentity(alias),
    ]);

    expect(aliasExecution.id).not.toBe(victimExecution.id);
  });

  it("changes execution identity when a Git pointer is retargeted in place", async () => {
    const { root, home } = await makeFixture();
    const first = join(root, "first");
    const second = join(root, "second");
    const alias = join(root, "alias");
    await createRepository({ path: first, home });
    await createRepository({ path: second, home });
    await mkdir(alias, { recursive: true });
    const pointerPath = join(alias, ".git");
    await writeFile(pointerPath, `gitdir: ${join(first, ".git")}\n`, "utf8");
    const before = await resolveRepositoryExecutionIdentity(alias);

    await writeFile(pointerPath, `gitdir: ${join(second, ".git")}\n`, "utf8");
    const after = await resolveRepositoryExecutionIdentity(alias);

    expect(after.id).not.toBe(before.id);
  });

  it("accepts a submodule Git directory bound through core.worktree", async () => {
    const { root, home } = await makeFixture();
    const child = join(root, "child");
    const parent = join(root, "parent");
    const submodule = join(parent, "submodule");
    await createRepository({ path: child, home });
    await createRepository({ path: parent, home });
    await runFixtureGit({
      argv: [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        child,
        "submodule",
      ],
      repoDir: parent,
      homeDir: home,
      cwd: parent,
    });

    const [parentExecution, submoduleExecution] = await Promise.all([
      resolveRepositoryExecutionIdentity(parent),
      resolveRepositoryExecutionIdentity(submodule),
    ]);

    expect(submoduleExecution.id).not.toBe(parentExecution.id);
  });

  it("preserves repository and execution identity across normal Git mutations", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const [repositoryBefore, executionBefore] = await Promise.all([
      resolveRepositoryIdentity(repo, home),
      resolveRepositoryExecutionIdentity(repo),
    ]);

    await writeFile(join(repo, "CHANGELOG.md"), "# Change\n", "utf8");
    await runFixtureGit({
      argv: ["add", "CHANGELOG.md"],
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
        "normal mutation",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });

    expect(await resolveRepositoryIdentity(repo, home)).toEqual(
      repositoryBefore
    );
    expect(await resolveRepositoryExecutionIdentity(repo)).toEqual(
      executionBefore
    );
  });

  it("distinguishes no-remote repositories with identical root history", async () => {
    const { root, home } = await makeFixture();
    const parent = join(root, "parent");
    const fork = join(root, "fork");
    await createRepository({ path: parent, home });
    await runFixtureGit({
      argv: ["clone", parent, fork],
      repoDir: fork,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: ["remote", "remove", "origin"],
      repoDir: fork,
      homeDir: home,
      cwd: fork,
    });

    const [parentIdentity, forkIdentity] = await Promise.all([
      resolveRepositoryIdentity(parent, home),
      resolveRepositoryIdentity(fork, home),
    ]);
    expect(parentIdentity.kind).toBe("git-common-dir");
    expect(forkIdentity.kind).toBe("git-common-dir");
    expect(parentIdentity.id).not.toBe(forkIdentity.id);
    expect(
      parentIdentity.aliases.find((alias) => alias.kind === "root-commit")?.id
    ).toBe(
      forkIdentity.aliases.find((alias) => alias.kind === "root-commit")?.id
    );
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
    expect(sshIdentity).toMatchObject({
      kind: "remote",
      fingerprint: "github.com/example/project",
    });
  });

  it("rejects Windows drive and UNC local paths as repository remotes", () => {
    expect(
      [
        String.raw`C:\work\project.git`,
        "C:/work/project.git",
        "C:repo.git",
        String.raw`\\server\share\project.git`,
        "//server/share/project.git",
      ].map(normalizeRepositoryRemote)
    ).toEqual([null, null, null, null, null]);
    expect(
      normalizeRepositoryRemote("git@github.com:example/project.git")
    ).toBe("github.com/example/project");
  });

  it("canonicalizes equivalent checkout paths for planning and state selection", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const alias = join(root, "repo-alias");
    await createRepository({ path: repo, home });
    await symlink(repo, alias, "dir");

    const directPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const aliasPlan = await planProjectEnrollment({
      projectRoot: alias,
      homeDir: home,
    });

    expect(aliasPlan.projectRoot).toBe(directPlan.projectRoot);
    expect(aliasPlan.executionIdentity).toEqual(directPlan.executionIdentity);
    expect(facultMachineStateDir(home, join(alias, ".ai"))).toBe(
      facultMachineStateDir(home, join(repo, ".ai"))
    );
    expect(repositoryPathComparisonKey("C:\\Work\\Project", "win32")).toBe(
      repositoryPathComparisonKey("c:\\work\\project", "win32")
    );
  });

  it("keeps forks with shared root history in separate portfolio identities", async () => {
    const { root, home } = await makeFixture();
    const source = join(root, "source");
    const upstream = join(root, "upstream");
    const fork = join(root, "fork");
    await createRepository({ path: source, home });
    await runFixtureGit({
      argv: ["clone", source, upstream],
      repoDir: upstream,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: ["clone", source, fork],
      repoDir: fork,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/project.git",
      ],
      repoDir: upstream,
      homeDir: home,
      cwd: upstream,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/project-fork.git",
      ],
      repoDir: fork,
      homeDir: home,
      cwd: fork,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "upstream",
        "https://github.com/example/project.git",
      ],
      repoDir: fork,
      homeDir: home,
      cwd: fork,
    });

    const discovery = await discoverProjects({
      roots: [upstream, fork],
      homeDir: home,
      maxVisits: 20,
      maxResults: 10,
    });
    expect(discovery.projects).toHaveLength(2);
    expect(discovery.groups).toHaveLength(2);
    expect(
      new Set(discovery.projects.map((project) => project.identity.id)).size
    ).toBe(2);

    const upstreamPlan = await planProjectEnrollment({
      projectRoot: upstream,
      homeDir: home,
    });
    const forkIdentityBeforeEnrollment = await resolveRepositoryIdentity(
      fork,
      home
    );
    expect(
      forkIdentityBeforeEnrollment.aliases.some(
        (alias) =>
          alias.kind === "remote" &&
          alias.fingerprint === "github.com/example/project"
      )
    ).toBe(false);
    await applyProjectEnrollment({
      plan: upstreamPlan,
      expectedPlanSha256: upstreamPlan.planSha256,
      homeDir: home,
    });
    const registryPath = upstreamPlan.machineLocalWrites[0]?.path ?? "";
    const legacyRegistry = (await Bun.file(registryPath).json()) as {
      projects: Record<string, { aliases: string[] }>;
    };
    legacyRegistry.projects[upstreamPlan.identity.id]?.aliases.push(
      forkIdentityBeforeEnrollment.id
    );
    await writeFile(
      registryPath,
      `${JSON.stringify(legacyRegistry, null, 2)}\n`,
      "utf8"
    );
    const forkPlan = await planProjectEnrollment({
      projectRoot: fork,
      homeDir: home,
    });
    expect(forkPlan.identity.id).toBe(forkIdentityBeforeEnrollment.id);
    expect(forkPlan.identity.id).not.toBe(upstreamPlan.identity.id);
    await applyProjectEnrollment({
      plan: forkPlan,
      expectedPlanSha256: forkPlan.planSha256,
      homeDir: home,
    });

    const registry = (await Bun.file(registryPath).json()) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(registry.projects).sort()).toEqual(
      [upstreamPlan.identity.id, forkPlan.identity.id].sort()
    );
  });

  it("keeps primary identity stable when origin is added, renamed, removed, or joined by other remotes", async () => {
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
    const initial = await resolveRepositoryIdentity(repo, home);
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
    const withOrigin = await resolveRepositoryIdentity(repo, home);

    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "aaa",
        "https://github.com/example/unrelated.git",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const withMultipleRemotes = await resolveRepositoryIdentity(repo, home);
    await runFixtureGit({
      argv: ["remote", "rename", "origin", "upstream"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const renamed = await resolveRepositoryIdentity(repo, home);
    await runFixtureGit({
      argv: ["remote", "remove", "upstream"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const removed = await resolveRepositoryIdentity(repo, home);

    expect(
      [withOrigin, withMultipleRemotes, renamed, removed].map(
        (identity) => identity.id
      )
    ).toEqual([initial.id, initial.id, initial.id, initial.id]);
    expect(withOrigin.aliases.some((alias) => alias.kind === "remote")).toBe(
      true
    );
  });

  it("preserves an enrolled remote primary when origin is removed", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/remote-first.git",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
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
      argv: ["remote", "remove", "origin"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });

    const withoutOrigin = await resolveRepositoryIdentity(repo, home);
    expect(plan.identity.kind).toBe("remote");
    expect(withoutOrigin.id).toBe(plan.identity.id);
    expect(withoutOrigin.kind).toBe("remote");
    expect(
      withoutOrigin.aliases.some((alias) => alias.kind === "git-common-dir")
    ).toBe(true);
  });

  it("keeps an uncommitted repository on its machine-local primary when origin changes", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "empty");
    await runFixtureGit({
      argv: ["init", "-b", "main", repo],
      repoDir: repo,
      homeDir: home,
      cwd: root,
    });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });
    const initial = await resolveRepositoryIdentity(repo, home);
    await runFixtureGit({
      argv: ["remote", "add", "origin", "https://github.com/example/empty.git"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const added = await resolveRepositoryIdentity(repo, home);
    await runFixtureGit({
      argv: ["remote", "rename", "origin", "upstream"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const renamed = await resolveRepositoryIdentity(repo, home);
    await runFixtureGit({
      argv: ["remote", "remove", "upstream"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const removed = await resolveRepositoryIdentity(repo, home);

    expect([added.id, renamed.id, removed.id]).toEqual([
      initial.id,
      initial.id,
      initial.id,
    ]);
    expect(initial.stability).toBe("machine-local");
  });

  it("does not inherit enrollment when Git metadata is replaced at the same path", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const original = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: original,
      expectedPlanSha256: original.planSha256,
      homeDir: home,
    });
    const originalState = facultMachineStateDir(home, join(repo, ".ai"));
    await writeFile(join(originalState, "runtime-marker"), "original\n");

    await rm(join(repo, ".git"), { recursive: true });
    await runFixtureGit({
      argv: ["init", "-b", "main"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: ["config", "user.name", "Fixture"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: ["config", "user.email", "fixture@example.test"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await writeFile(join(repo, "README.md"), "# Replacement\n", "utf8");
    await runFixtureGit({
      argv: ["add", "README.md"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: ["commit", "-m", "replacement"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });

    const replacement = await resolveRepositoryIdentity(repo, home);
    const replacementState = facultMachineStateDir(home, join(repo, ".ai"));
    expect(replacement.id).not.toBe(original.identity.id);
    expect(replacementState).not.toBe(originalState);
    expect(
      await Bun.file(join(replacementState, "runtime-marker")).exists()
    ).toBe(false);
  });

  it("does not stabilize a same-path fork from shared root history alone", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const fork = join(root, "fork");
    await createRepository({ path: repo, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/parent.git",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: ["clone", repo, fork],
      repoDir: fork,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/fork.git",
      ],
      repoDir: fork,
      homeDir: home,
      cwd: fork,
    });
    const parentPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: parentPlan,
      expectedPlanSha256: parentPlan.planSha256,
      homeDir: home,
    });
    const forkIdentity = await resolveRepositoryIdentity(
      fork,
      join(root, "unregistered-home")
    );
    const registryPath = parentPlan.machineLocalWrites[0]?.path ?? "";
    const registry = (await Bun.file(registryPath).json()) as {
      projects: Record<string, { aliases: string[] }>;
    };
    registry.projects[parentPlan.identity.id]?.aliases.push(forkIdentity.id);
    await writeFile(
      registryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8"
    );

    await rename(join(repo, ".git"), join(root, "parent.git"));
    await rename(join(fork, ".git"), join(repo, ".git"));

    const replacement = await resolveRepositoryIdentity(repo, home);
    expect(replacement.id).toBe(forkIdentity.id);
    expect(replacement.id).not.toBe(parentPlan.identity.id);
    expect(
      replacement.aliases.some(
        (alias) =>
          alias.kind === "root-commit" &&
          parentPlan.identity.aliases.some(
            (parentAlias) =>
              parentAlias.kind === "root-commit" && parentAlias.id === alias.id
          )
      )
    ).toBe(true);
  });

  it("distinguishes no-origin forks by their normalized remote sets", async () => {
    const { root, home } = await makeFixture();
    const parent = join(root, "parent");
    const fork = join(root, "fork");
    await createRepository({ path: parent, home });
    await runFixtureGit({
      argv: ["clone", parent, fork],
      repoDir: fork,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: ["remote", "remove", "origin"],
      repoDir: fork,
      homeDir: home,
      cwd: fork,
    });
    for (const [repo, own] of [
      [parent, "parent"],
      [fork, "fork"],
    ] as const) {
      await runFixtureGit({
        argv: [
          "remote",
          "add",
          "upstream",
          `https://github.com/example/${own}.git`,
        ],
        repoDir: repo,
        homeDir: home,
        cwd: repo,
      });
      await runFixtureGit({
        argv: [
          "remote",
          "add",
          "mirror",
          "https://github.com/example/shared.git",
        ],
        repoDir: repo,
        homeDir: home,
        cwd: repo,
      });
    }
    const discovery = await discoverProjects({
      roots: [parent, fork],
      homeDir: home,
    });
    expect(
      new Set(discovery.projects.map((project) => project.identity.id)).size
    ).toBe(2);
  });

  it("does not refresh the Git index during discovery", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const indexPath = join(repo, ".git", "index");
    const trackedPath = join(repo, "README.md");
    await utimes(
      trackedPath,
      new Date("2040-01-01T00:00:00.000Z"),
      new Date("2040-01-01T00:00:00.000Z")
    );
    const beforeBytes = await readFile(indexPath);
    const beforeStat = await stat(indexPath);

    await discoverProjects({
      roots: [repo],
      maxVisits: 10,
      maxResults: 10,
    });

    const afterBytes = await readFile(indexPath);
    const afterStat = await stat(indexPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
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
  it("refuses direct and CLI planning when the project AI root is global without writes", async () => {
    const { root, home } = await makeFixture();
    await createRepository({ path: home, home: join(root, "git-home") });
    const before = await listTree(home);

    await expect(
      planProjectEnrollment({ projectRoot: home, homeDir: home })
    ).rejects.toThrow("collides with the configured global AI root");
    expect(await listTree(home)).toEqual(before);
    expect(await pathEntryExists(join(home, ".ai"))).toBe(false);

    const logs: string[] = [];
    const errors: string[] = [];
    const previousLog = console.log;
    const previousError = console.error;
    let cliExitCode: number | string | null | undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    process.exitCode = 0;
    try {
      await projectCommand(["init", "--project-root", home, "--json"], {
        cwd: home,
        homeDir: home,
      });
      cliExitCode = process.exitCode;
    } finally {
      console.log = previousLog;
      console.error = previousError;
      process.exitCode = 0;
    }

    expect(cliExitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain(
      "collides with the configured global AI root"
    );
    expect(await listTree(home)).toEqual(before);
    expect(await pathEntryExists(join(home, ".ai"))).toBe(false);
  });

  it("refuses a physically equivalent configured global root and preserves normal planning", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const otherRepo = join(root, "other-repo");
    const globalAlias = join(root, "configured-global");
    await createRepository({ path: repo, home });
    await createRepository({ path: otherRepo, home });
    await mkdir(join(repo, ".ai"), { recursive: true });
    await symlink(
      join(repo, ".ai"),
      globalAlias,
      process.platform === "win32" ? "junction" : "dir"
    );
    await mkdir(dirname(facultConfigPath(home)), { recursive: true });
    await writeFile(
      facultConfigPath(home),
      `${JSON.stringify({ rootDir: globalAlias })}\n`,
      "utf8"
    );
    const before = await listTree(repo);

    await expect(
      planProjectEnrollment({ projectRoot: repo, homeDir: home })
    ).rejects.toThrow("collides with the configured global AI root");
    expect(await listTree(repo)).toEqual(before);

    const plan = await planProjectEnrollment({
      projectRoot: otherRepo,
      homeDir: home,
    });
    expect(plan.projectRoot).toBe(otherRepo);
    expect(plan.aiRoot).toBe(join(otherRepo, ".ai"));
    expect(await pathEntryExists(join(otherRepo, ".ai"))).toBe(false);
    expect(
      pathsPhysicallyEquivalent(
        "C:\\Users\\Dimitri\\.ai",
        "c:\\users\\dimitri\\.AI",
        "win32"
      )
    ).toBe(true);
    expect(
      pathsPhysicallyEquivalent(
        "C:\\Users\\Dimitri\\.ai",
        "C:\\Users\\Dimitri\\project\\.ai",
        "win32"
      )
    ).toBe(false);
  });

  it("conservatively refuses missing global and project roots that differ only by case", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "case-collision-repo");
    await createRepository({ path: repo, home });
    const projectAiRoot = join(repo, ".ai");
    const configuredGlobalRoot = join(repo, ".AI");
    if (process.platform === "win32") {
      return;
    }
    await mkdir(dirname(facultConfigPath(home)), { recursive: true });
    await writeFile(
      facultConfigPath(home),
      `${JSON.stringify({ rootDir: configuredGlobalRoot })}\n`,
      "utf8"
    );
    const before = await listTree(repo);

    await expect(
      planProjectEnrollment({ projectRoot: repo, homeDir: home })
    ).rejects.toThrow("collides with the configured global AI root");
    expect(await listTree(repo)).toEqual(before);
    expect(await pathEntryExists(projectAiRoot)).toBe(false);
    expect(await pathEntryExists(configuredGlobalRoot)).toBe(false);
  });

  it("rejects unsupported Windows enrollment during planning without writes", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const before = await listTree(repo);

    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        platform: "win32",
      })
    ).rejects.toThrow("planning is unsupported on win32");
    expect(await listTree(repo)).toEqual(before);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);

    const reviewedPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      platform: "linux",
    });
    await expect(
      applyProjectEnrollment({
        plan: reviewedPlan,
        expectedPlanSha256: reviewedPlan.planSha256,
        homeDir: home,
        platform: "win32",
      })
    ).rejects.toThrow("registry mutation is unsupported on win32");
    expect(await listTree(repo)).toEqual(before);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
    expect(
      await Bun.file(reviewedPlan.machineLocalWrites[0]?.path ?? "").exists()
    ).toBe(false);
  });

  it("rejects malformed registry containers and entries before enrollment writes", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const registryPath = plan.machineLocalWrites[0]?.path;
    if (!registryPath) {
      throw new Error("Expected a project registry path");
    }
    await mkdir(dirname(registryPath), { recursive: true });
    const key = "repo_000000000000000000000000";
    const malformedContents = [
      "",
      ...[[], null, 42, { [key]: null }, { [key]: { repositoryId: key } }].map(
        (projects) =>
          `${JSON.stringify({
            version: 1,
            updatedAt: "2026-07-29T12:00:00.000Z",
            projects,
          })}\n`
      ),
    ];

    for (const content of malformedContents) {
      await writeFile(registryPath, content, "utf8");

      await expect(
        applyProjectEnrollment({
          plan,
          expectedPlanSha256: plan.planSha256,
          homeDir: home,
        })
      ).rejects.toThrow("Project registry is invalid");
      expect(await readFile(registryPath, "utf8")).toBe(content);
      expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
      expect(
        await readdir(join(dirname(registryPath), "receipts")).catch(() => [])
      ).toEqual([]);
    }
  });

  it("fails when an existing canonical file cannot be read", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const ignorePath = join(repo, ".ai", ".gitignore");
    await mkdir(dirname(ignorePath), { recursive: true });
    await writeFile(ignorePath, "/user-rule\n", "utf8");
    await chmod(ignorePath, 0o000);
    try {
      await expect(
        planProjectEnrollment({ projectRoot: repo, homeDir: home })
      ).rejects.toThrow();
    } finally {
      await chmod(ignorePath, 0o600);
    }
  });

  it("rejects a legacy state migration that appeared after preview", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    expect(plan.stateMigrations).toEqual([]);
    const legacyDir = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "journal.jsonl"), "preserve\n", "utf8");

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
      })
    ).rejects.toThrow("state migrations changed");
    expect(await readFile(join(legacyDir, "journal.jsonl"), "utf8")).toBe(
      "preserve\n"
    );
    expect(await Bun.file(facultMachineStateDir(home, aiRoot)).exists()).toBe(
      false
    );
    expect(await Bun.file(aiRoot).exists()).toBe(false);
  });

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
      plan.generatedWrites.every((write) =>
        write.path.includes(plan.executionIdentity.id)
      )
    ).toBe(true);
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

  it("rejects guidance replaced after Git verification before reading", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outside = join(root, "outside.md");
    const guidance = "# Reviewed guidance\n";
    await createRepository({
      path: repo,
      home,
      files: { "AGENTS.md": guidance },
    });
    await writeFile(outside, guidance, "utf8");

    await expect(
      planProjectEnrollment({
        beforeGuidanceRead: async () => {
          await rename(
            join(repo, "AGENTS.md"),
            join(repo, "AGENTS.original.md")
          );
          await symlink(outside, join(repo, "AGENTS.md"));
        },
        projectRoot: repo,
        homeDir: home,
        guidance: ["AGENTS.md"],
      })
    ).rejects.toThrow("source changed before read");
    expect(await readFile(outside, "utf8")).toBe(guidance);
    expect((await lstat(join(repo, "AGENTS.md"))).isSymbolicLink()).toBe(true);
  });

  it("rejects canonical files replaced after target verification before preview", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outside = join(root, "outside.toml");
    await createRepository({ path: repo, home });
    await mkdir(join(repo, ".ai"), { recursive: true });
    await writeFile(
      join(repo, ".ai", "config.toml"),
      "version = 1\n\n[custom]\nowned = true\n",
      "utf8"
    );
    await writeFile(
      outside,
      "version = 1\n\n[private]\nowned = false\n",
      "utf8"
    );

    await expect(
      planProjectEnrollment({
        beforeCanonicalPreviewRead: async () => {
          await rename(
            join(repo, ".ai", "config.toml"),
            join(repo, ".ai", "config.original.toml")
          );
          await symlink(outside, join(repo, ".ai", "config.toml"));
        },
        projectRoot: repo,
        homeDir: home,
      })
    ).rejects.toThrow("unsafe canonical file");
    expect(await readFile(outside, "utf8")).toBe(
      "version = 1\n\n[private]\nowned = false\n"
    );
    expect(
      (await lstat(join(repo, ".ai", "config.toml"))).isSymbolicLink()
    ).toBe(true);
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
    ).rejects.toThrow("byte-for-byte clean");
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);

    await writeFile(join(repo, "CLAUDE.md"), "# Untracked\n", "utf8");
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["CLAUDE.md"],
      })
    ).rejects.toThrow("byte-for-byte clean");
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });

  it("refuses assume-unchanged and skip-worktree guidance whose worktree bytes drift", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const reviewed = "# Reviewed guidance\n";
    await createRepository({
      path: repo,
      home,
      files: { "AGENTS.md": reviewed },
    });

    await runFixtureGit({
      argv: ["update-index", "--assume-unchanged", "AGENTS.md"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await writeFile(join(repo, "AGENTS.md"), "# Hidden local edit\n", "utf8");
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["AGENTS.md"],
      })
    ).rejects.toThrow("byte-for-byte clean");

    await runFixtureGit({
      argv: ["update-index", "--no-assume-unchanged", "AGENTS.md"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await writeFile(join(repo, "AGENTS.md"), reviewed, "utf8");
    await runFixtureGit({
      argv: ["update-index", "--skip-worktree", "AGENTS.md"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await writeFile(
      join(repo, "AGENTS.md"),
      "# Hidden worktree edit\n",
      "utf8"
    );
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["AGENTS.md"],
      })
    ).rejects.toThrow("byte-for-byte clean");
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
          '# Safe public guidance\n\nUse https://example.com/home/docs, https://example.com/search?next=(/tmp/private), [Docs](/tmp/help "Guide"), [Reference][docs], <a href=/var/help>Guide</a>, <script src="//cdn.example.com/app.js"></script>, option C: recommended, and docs/config.toml.\n\n[docs]: /home/help "Home"\n',
        "docs/url-paths.md":
          "# Safe public guidance\n\nUse https://example.com/?next=/tmp/private#fallback=/home/alice/private and https://example.com/docs#source=/opt/company/internal.\n",
        "docs/local.md":
          "# Local\n\nRead /Users/example/private/config.toml.\n",
        "docs/linux-home.md": "# Local\n\nRead /home/alice/private.toml.\n",
        "docs/root-home.md": "# Local\n\nRead /root/.ssh/config.\n",
        "docs/workspace-local.md":
          "# Local\n\nRead /workspace/alice/private.md.\n",
        "docs/tmp-local.md": "# Local\n\nRead /tmp/acme/token.\n",
        "docs/opt-local.md": "# Local\n\nRead /opt/company/internal.md.\n",
        "docs/colon-local.md":
          "# Local\n\nLocal path:/opt/company/internal.md.\n",
        "docs/boot-local.md": "# Local\n\nRead /boot/loader/private.\n",
        "docs/lib-local.md": "# Local\n\nRead /lib/private-config.\n",
        "docs/media-local.md": "# Local\n\nRead /media/alice/private.\n",
        "docs/data-local.md": "# Local\n\nRead /data/alice/private.md.\n",
        "docs/net-local.md": "# Local\n\nRead /net/company/internal.\n",
        "docs/nix-local.md": "# Local\n\nRead /nix/store/private-config.\n",
        "docs/html-data-local.md":
          "# Local\n\n<code>/data/alice/private.md</code>\n",
        "docs/html-net-local.md":
          "# Local\n\n<span>/net/company/internal</span>\n",
        "docs/html-nix-local.md":
          "# Local\n\n<pre>/nix/store/private-config</pre>\n",
        "docs/trailing-root-local.md": '# Local\n\nRead "/tmp/".\n',
        "docs/windows-backslash.md": String.raw`# Local

Read C:\Users\Alice\private.toml.
`,
        "docs/windows-forward.md":
          "# Local\n\nRead C:/Users/Alice/private.toml.\n",
        "docs/windows-drive-relative.md": String.raw`# Local

Read D:private\config.toml.
`,
        "docs/windows-unc.md": String.raw`# Local

Read \\server\share\private.toml.
`,
        "docs/windows-forward-unc.md":
          "# Local\n\nRead //server/share/private.toml.\n",
        "docs/secret.md": "# Secret\n\napi_key = abcdefghijklmnop\n",
        "docs/github-token.md":
          "# Secret\n\nghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n",
        "docs/github-fine-grained-token.md":
          "# Secret\n\ngithub_pat_11AA00_exampleExampleExampleExample\n",
        "docs/github-stateless-token.md": `# Secret

ghs_APP_ID.${"a".repeat(240)}.${"b".repeat(240)}
`,
        "docs/aws-token.md": "# Secret\n\nAKIAIOSFODNN7EXAMPLE\n",
        "docs/oversized.md": `# Oversized\n\n${"a".repeat(1024 * 1024)}\n`,
      },
    });
    await mkdir(join(repo, ".ai"), { recursive: true });
    await writeFile(
      join(repo, ".ai", ".gitignore"),
      "# https://example.com/?next=/tmp/private\n//cache/\n",
      "utf8"
    );

    const safe = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      guidance: ["docs/safe.md", "docs/url-paths.md"],
    });
    expect(safe.guidancePreview[0]?.path).toBe("docs/safe.md");
    expect(safe.guidancePreview[1]?.path).toBe("docs/url-paths.md");
    for (const guidance of [
      "docs/local.md",
      "docs/linux-home.md",
      "docs/root-home.md",
      "docs/workspace-local.md",
      "docs/tmp-local.md",
      "docs/opt-local.md",
      "docs/colon-local.md",
      "docs/boot-local.md",
      "docs/lib-local.md",
      "docs/media-local.md",
      "docs/data-local.md",
      "docs/net-local.md",
      "docs/nix-local.md",
      "docs/html-data-local.md",
      "docs/html-net-local.md",
      "docs/html-nix-local.md",
      "docs/trailing-root-local.md",
      "docs/windows-backslash.md",
      "docs/windows-forward.md",
      "docs/windows-drive-relative.md",
      "docs/windows-unc.md",
      "docs/windows-forward-unc.md",
    ]) {
      await expect(
        planProjectEnrollment({
          projectRoot: repo,
          homeDir: home,
          guidance: [guidance],
        })
      ).rejects.toThrow("machine-local absolute path");
    }
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["docs/secret.md"],
      })
    ).rejects.toThrow("secret-shaped content");
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        guidance: ["docs/oversized.md"],
      })
    ).rejects.toThrow("exceeds the 1 MiB preview limit");
    for (const guidance of [
      "docs/github-token.md",
      "docs/github-fine-grained-token.md",
      "docs/github-stateless-token.md",
      "docs/aws-token.md",
    ]) {
      await expect(
        planProjectEnrollment({
          projectRoot: repo,
          homeDir: home,
          guidance: [guidance],
        })
      ).rejects.toThrow("secret-shaped content");
    }
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
      "Refusing to update an invalid canonical project enrollment config"
    );
  });

  it("updates a valid enrollment and rollback restores the prior project config", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({
      path: repo,
      home,
      files: { "AGENTS.md": "# Reviewed project guidance\n" },
    });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    const configPath = join(repo, ".ai", "config.toml");
    const firstConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${firstConfig.trimEnd()}\n\n[custom]\nowned = true\n`,
      "utf8"
    );

    const secondPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      cadence: "weekly",
      guidance: ["AGENTS.md"],
      sources: ["git", "writebacks"],
    });
    expect(secondPlan.canonicalWrites[1]?.content).toContain(
      'cadence = "weekly"'
    );
    expect(secondPlan.canonicalWrites[1]?.content).toContain(
      'guidance = ["AGENTS.md"]'
    );
    expect(secondPlan.canonicalWrites[1]?.content).toContain(
      "[custom]\nowned = true"
    );
    const updatedConfig = secondPlan.canonicalWrites[1]?.content;
    if (!updatedConfig) {
      throw new Error("Expected a canonical project config write");
    }
    const beforeSecondApply = await readFile(configPath, "utf8");
    const second = await applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-29T11:00:00.000Z"),
    });
    expect(await readFile(configPath, "utf8")).toBe(updatedConfig);

    await rollbackProjectEnrollment({
      receiptId: second.receiptId,
      homeDir: home,
      apply: true,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });
    expect(await readFile(configPath, "utf8")).toBe(beforeSecondApply);
  });

  it("updates the owned project table without matching multiline TOML content", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
    });
    const configPath = join(repo, ".ai", "config.toml");
    const firstConfig = await readFile(configPath, "utf8");
    const authoredPrefix = [
      "version = 1",
      "",
      "[custom]",
      'description = """',
      "[project]",
      'this is authored text, not a table header"""',
      "",
    ].join("\n");
    const existing = `${authoredPrefix}${firstConfig.slice(
      firstConfig.indexOf("[project]")
    )}\n[ "after]quoted" ] # preserved table\nowned = true\n`;
    await writeFile(configPath, existing, "utf8");

    const nextPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      cadence: "weekly",
    });
    const updated = nextPlan.canonicalWrites[1]?.content ?? "";
    expect(Bun.TOML.parse(updated)).toMatchObject({
      "after]quoted": { owned: true },
      custom: {
        description: "\n[project]\nthis is authored text, not a table header",
      },
      project: { cadence: "weekly" },
    });
    expect(updated).toContain(authoredPrefix);
    expect(updated.match(/^\[project\]$/gm)).toHaveLength(2);
  });

  it("updates a parser-equivalent quoted project table header", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
    });
    const configPath = join(repo, ".ai", "config.toml");
    const firstConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${firstConfig.replace("[project]", '["project"]')}\n[custom]\nowned = true\n`,
      "utf8"
    );

    const nextPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      cadence: "weekly",
    });
    const updated = nextPlan.canonicalWrites[1]?.content ?? "";
    expect(Bun.TOML.parse(updated)).toMatchObject({
      custom: { owned: true },
      project: { cadence: "weekly" },
    });
    expect(updated).not.toContain('["project"]');
    expect(updated).toContain("[project]");
  });

  it("reasserts protective ignores after conflicting negations", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    await mkdir(join(repo, ".ai"), { recursive: true });
    await writeFile(
      join(repo, ".ai", ".gitignore"),
      [
        "/.facult/",
        "!/.facult/",
        "/config.local.toml",
        "!/config.local.toml",
        "",
      ].join("\n"),
      "utf8"
    );

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const ignore = plan.canonicalWrites[0]?.content ?? "";

    expect(ignore.lastIndexOf("/.facult/")).toBeGreaterThan(
      ignore.lastIndexOf("!/.facult/")
    );
    expect(ignore.lastIndexOf("/config.local.toml")).toBeGreaterThan(
      ignore.lastIndexOf("!/config.local.toml")
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
  it("uses shared canonical modes, private local modes, and restores prior modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { root, home } = await makeFixture();
    const freshRepo = join(root, "fresh");
    await createRepository({ path: freshRepo, home });
    const freshPlan = await planProjectEnrollment({
      projectRoot: freshRepo,
      homeDir: home,
    });
    const freshResult = await applyProjectEnrollment({
      plan: freshPlan,
      expectedPlanSha256: freshPlan.planSha256,
      homeDir: home,
    });
    for (const pathValue of freshResult.changedPaths) {
      expect((await stat(pathValue)).mode % 0o1000).toBe(0o644);
    }
    for (const pathValue of [
      ...freshResult.generatedPaths,
      freshResult.registryPath,
      join(
        facultLocalStateRoot(home),
        "projects",
        "receipts",
        `${freshResult.receiptId}.json`
      ),
    ]) {
      expect((await stat(pathValue)).mode % 0o1000).toBe(0o600);
    }

    const existingRepo = join(root, "existing");
    const existingAi = join(existingRepo, ".ai");
    const ignorePath = join(existingAi, ".gitignore");
    const configPath = join(existingAi, "config.toml");
    await createRepository({ path: existingRepo, home });
    await mkdir(existingAi, { recursive: true });
    await writeFile(ignorePath, "# existing\n", "utf8");
    await writeFile(
      configPath,
      'version = 1\n\n[custom]\nvalue = "preserve"\n',
      "utf8"
    );
    await chmod(ignorePath, 0o640);
    await chmod(configPath, 0o664);
    const existingPlan = await planProjectEnrollment({
      projectRoot: existingRepo,
      homeDir: home,
    });
    expect(
      existingPlan.canonicalWrites.map((write) => write.precondition.mode)
    ).toEqual([0o640, 0o664]);
    const existingResult = await applyProjectEnrollment({
      plan: existingPlan,
      expectedPlanSha256: existingPlan.planSha256,
      homeDir: home,
    });
    expect((await stat(ignorePath)).mode % 0o1000).toBe(0o640);
    expect((await stat(configPath)).mode % 0o1000).toBe(0o664);

    await rollbackProjectEnrollment({
      receiptId: existingResult.receiptId,
      homeDir: home,
      apply: true,
    });
    expect(await readFile(ignorePath, "utf8")).toBe("# existing\n");
    expect(await readFile(configPath, "utf8")).toBe(
      'version = 1\n\n[custom]\nvalue = "preserve"\n'
    );
    expect((await stat(ignorePath)).mode % 0o1000).toBe(0o640);
    expect((await stat(configPath)).mode % 0o1000).toBe(0o664);
  });

  it("atomically migrates legacy path-keyed machine state before enrollment", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyDir = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const preserved = {
      "journal/events.jsonl": '{"event":"preserve"}\n',
      "ai/project/writeback/queue.jsonl": '{"writeback":"preserve"}\n',
      "ai/project/evolution/proposals/review.json": '{"proposal":"preserve"}\n',
      "managed.json": '{"managed":"preserve"}\n',
      "autosync/state.json": '{"autosync":"preserve"}\n',
    };
    for (const [relativePath, content] of Object.entries(preserved)) {
      const pathValue = join(legacyDir, relativePath);
      await mkdir(dirname(pathValue), { recursive: true });
      await writeFile(pathValue, content, "utf8");
    }
    expect(facultMachineStateDir(home, aiRoot)).toBe(legacyDir);
    const legacyKey = legacyMachineStateProjectKey(aiRoot, home);
    const executionId = (await resolveRepositoryExecutionIdentity(repo)).id;
    const reviewMirrors = [
      {
        source: join(
          home,
          ".ai",
          "writebacks",
          "projects",
          legacyKey,
          "review.md"
        ),
        destination: join(
          home,
          ".ai",
          "writebacks",
          "projects",
          executionId,
          "review.md"
        ),
      },
      {
        source: join(
          home,
          ".ai",
          "evolution",
          "projects",
          legacyKey,
          "review.md"
        ),
        destination: join(
          home,
          ".ai",
          "evolution",
          "projects",
          executionId,
          "review.md"
        ),
      },
      {
        source: join(
          home,
          ".ai",
          "reconciliation",
          "projects",
          legacyKey,
          "review.md"
        ),
        destination: join(
          home,
          ".ai",
          "reconciliation",
          "projects",
          executionId,
          "review.md"
        ),
      },
    ];
    for (const mirror of reviewMirrors) {
      await mkdir(dirname(mirror.source), { recursive: true });
      await writeFile(mirror.source, "# Preserve review\n", "utf8");
    }

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    expect(plan.stateMigrations).toHaveLength(4);
    expect(plan.stateMigrations.map((migration) => migration.source)).toEqual([
      legacyDir,
      ...reviewMirrors.map((mirror) => dirname(mirror.source)),
    ]);
    expect(
      plan.stateMigrations.every(
        (migration) =>
          migration.reason.includes("Preserve legacy path-keyed") &&
          migration.destination.includes(plan.executionIdentity.id)
      )
    ).toBe(true);
    const output: string[] = [];
    const previousLog = console.log;
    console.log = (value?: unknown) => output.push(String(value));
    try {
      await projectCommand(["init", "--project-root", repo], {
        homeDir: home,
      });
    } finally {
      console.log = previousLog;
    }
    expect(
      (JSON.parse(output.join("\n")) as { stateMigrations: unknown[] })
        .stateMigrations
    ).toEqual(plan.stateMigrations);
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });

    const selectedDir = facultMachineStateDir(home, aiRoot);
    expect(selectedDir).not.toBe(legacyDir);
    expect(await Bun.file(legacyDir).exists()).toBe(false);
    for (const [relativePath, content] of Object.entries(preserved)) {
      expect(await readFile(join(selectedDir, relativePath), "utf8")).toBe(
        content
      );
    }
    for (const mirror of reviewMirrors) {
      expect(await Bun.file(mirror.source).exists()).toBe(false);
      expect(await readFile(mirror.destination, "utf8")).toBe(
        "# Preserve review\n"
      );
    }
  });

  it("refuses enrollment migration while reconciliation or evolution owns runtime state", async () => {
    for (const writer of ["reconciliation", "evolution"] as const) {
      const { root, home } = await makeFixture();
      const repo = join(root, `repo-${writer}`);
      await createRepository({ path: repo, home });
      const aiRoot = join(repo, ".ai");
      const legacyDir = join(
        facultLocalStateRoot(home),
        "projects",
        legacyMachineStateProjectKey(aiRoot, home)
      );
      await mkdir(join(legacyDir, "journal"), { recursive: true });
      await writeFile(
        join(legacyDir, "journal", "events.jsonl"),
        `${writer} state\n`,
        "utf8"
      );
      await mkdir(aiRoot, { recursive: true });
      await writeFile(
        join(aiRoot, "reconciliation.json"),
        `${JSON.stringify({
          version: 1,
          sources: [
            {
              id: "runtime-export",
              type: "evidence-export",
              path: "evidence.json",
            },
          ],
        })}\n`,
        "utf8"
      );
      await writeFile(
        join(repo, "evidence.json"),
        `${JSON.stringify({
          version: 1,
          producer: "migration-lock-fixture",
          generatedAt: "2026-01-03T00:00:00.000Z",
          coverage: {
            since: "2026-01-01T00:00:00.000Z",
            until: "2026-01-02T23:59:59.999Z",
            complete: true,
          },
          events: [],
        })}\n`,
        "utf8"
      );
      if (writer === "evolution") {
        await enableEvolutionLoop({
          homeDir: home,
          rootDir: aiRoot,
          now: () => new Date("2026-01-03T00:00:00.000Z"),
        });
      }
      const plan = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      });
      expect(plan.stateMigrations.length).toBeGreaterThan(0);

      let markLocked: (() => void) | undefined;
      const locked = new Promise<void>((resolveLocked) => {
        markLocked = resolveLocked;
      });
      let releaseWriter: (() => void) | undefined;
      const holdWriter = new Promise<void>((resolveWriter) => {
        releaseWriter = resolveWriter;
      });
      const writerRun =
        writer === "reconciliation"
          ? reconcileSources({
              homeDir: home,
              rootDir: aiRoot,
              since: "2026-01-01",
              until: "2026-01-02",
              onLockAcquired: async () => {
                markLocked?.();
                await holdWriter;
              },
            })
          : runEvolutionLoop({
              homeDir: home,
              rootDir: aiRoot,
              since: "2026-01-01",
              until: "2026-01-02",
              now: () => new Date("2026-01-03T00:00:00.000Z"),
              onLockAcquired: async () => {
                markLocked?.();
                await holdWriter;
              },
            });
      await locked;

      const expectedLockPath =
        writer === "reconciliation"
          ? facultAiReconciliationLockPath(home, aiRoot)
          : facultAiEvolutionLoopLockPath(home, aiRoot);
      expect(await Bun.file(expectedLockPath).exists()).toBe(true);
      await expect(
        applyProjectEnrollment({
          plan,
          expectedPlanSha256: plan.planSha256,
          homeDir: home,
        })
      ).rejects.toThrow("another writer holds");
      expect(await pathEntryExists(legacyDir)).toBe(true);

      releaseWriter?.();
      await writerRun;
      const refreshed = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      });
      await applyProjectEnrollment({
        plan: refreshed,
        expectedPlanSha256: refreshed.planSha256,
        homeDir: home,
      });
      expect(await pathEntryExists(legacyDir)).toBe(true);
      expect(
        (
          await planProjectEnrollment({
            projectRoot: repo,
            homeDir: home,
          })
        ).stateMigrations
      ).toEqual([]);
      expect(
        await Bun.file(
          join(facultMachineStateDir(home, aiRoot), "journal", "events.jsonl")
        ).exists()
      ).toBe(true);
    }
  });

  it("rejects legacy runtime lock files before planning a migration", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyDir = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const oldLockPath = join(
      legacyDir,
      "ai",
      "project",
      "evolution",
      "loop",
      "state.json.lock"
    );
    await mkdir(dirname(oldLockPath), { recursive: true });
    await writeFile(oldLockPath, '{"pid":123}\n', "utf8");

    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      })
    ).rejects.toThrow("Refusing to migrate active project runtime state");
    expect(await Bun.file(oldLockPath).exists()).toBe(true);
  });

  it("rejects legacy reconciliation takeover files before planning a migration", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyDir = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const oldLockPath = join(
      legacyDir,
      "ai",
      "project",
      "reconciliation",
      "state.json.lock.takeover"
    );
    await mkdir(dirname(oldLockPath), { recursive: true });
    await writeFile(oldLockPath, '{"pid":123}\n', "utf8");

    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      })
    ).rejects.toThrow("Refusing to migrate active project runtime state");
    expect(await Bun.file(oldLockPath).exists()).toBe(true);
  });

  it("rejects selected runtime lock files before planning a migration", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyDir = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedDir = join(
      facultLocalStateRoot(home),
      "projects",
      executionMachineStateProjectKey(aiRoot, home)
    );
    await mkdir(join(legacyDir, "journal"), { recursive: true });
    await writeFile(
      join(legacyDir, "journal", "events.jsonl"),
      '{"legacy":true}\n',
      "utf8"
    );
    const oldLockPath = join(
      selectedDir,
      "ai",
      "project",
      "evolution",
      "loop",
      "state.json.lock"
    );
    await mkdir(dirname(oldLockPath), { recursive: true });
    await writeFile(oldLockPath, '{"pid":123}\n', "utf8");

    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      })
    ).rejects.toThrow("Refusing to migrate active project runtime state");
    expect(await Bun.file(oldLockPath).exists()).toBe(true);
    expect(await pathEntryExists(legacyDir)).toBe(true);
  });

  it("revalidates selected runtime lock files before applying a migration", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyDir = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedDir = join(
      facultLocalStateRoot(home),
      "projects",
      executionMachineStateProjectKey(aiRoot, home)
    );
    await mkdir(join(legacyDir, "journal"), { recursive: true });
    await writeFile(
      join(legacyDir, "journal", "events.jsonl"),
      '{"legacy":true}\n',
      "utf8"
    );
    await mkdir(join(selectedDir, "ai", "project", "writeback"), {
      recursive: true,
    });
    await writeFile(
      join(selectedDir, "ai", "project", "writeback", "queue.jsonl"),
      '{"selected":true}\n',
      "utf8"
    );
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const oldLockPath = join(
      selectedDir,
      "ai",
      "project",
      "reconciliation",
      "state.json.lock.takeover"
    );
    await mkdir(dirname(oldLockPath), { recursive: true });
    await writeFile(oldLockPath, '{"pid":123}\n', "utf8");

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
      })
    ).rejects.toThrow("Refusing to migrate active project runtime state");
    expect(await Bun.file(oldLockPath).exists()).toBe(true);
    expect(await pathEntryExists(legacyDir)).toBe(true);
  });

  it("migrates a legacy key created through an equivalent symlink spelling", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const alias = join(root, "repo-alias");
    await createRepository({ path: repo, home });
    await symlink(
      repo,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    const aliasAiRoot = join(alias, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aliasAiRoot, home)
    );
    const unrelatedLegacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(join(root, "unrelated-alias", ".ai"), home)
    );
    const journal = join(legacyState, "journal", "events.jsonl");
    await mkdir(dirname(journal), { recursive: true });
    await writeFile(journal, "symlink invocation\n", "utf8");
    await mkdir(unrelatedLegacyState, { recursive: true });
    await writeFile(
      join(unrelatedLegacyState, "unrelated.jsonl"),
      "do not adopt\n",
      "utf8"
    );

    const plan = await planProjectEnrollment({
      projectRoot: alias,
      homeDir: home,
    });
    expect(plan.projectRoot).toBe(repo);
    expect(plan.legacyStateRoots).toContain(aliasAiRoot);
    expect(
      plan.stateMigrations.some(
        (migration) => migration.source === unrelatedLegacyState
      )
    ).toBe(false);
    expect(plan.stateMigrations).toEqual([
      expect.objectContaining({
        source: legacyState,
        destination: facultMachineStateDir(home, join(repo, ".ai")),
      }),
    ]);

    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });

    expect(await pathEntryExists(legacyState)).toBe(false);
    expect(
      await readFile(join(unrelatedLegacyState, "unrelated.jsonl"), "utf8")
    ).toBe("do not adopt\n");
    expect(
      await readFile(
        join(
          facultMachineStateDir(home, join(repo, ".ai")),
          "journal",
          "events.jsonl"
        ),
        "utf8"
      )
    ).toBe("symlink invocation\n");
  });

  it("uses an identity-matched persisted location as a legacy key candidate", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const alias = join(root, "persisted-alias");
    await createRepository({ path: repo, home });
    await symlink(
      repo,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const first = await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
    });
    const registry = (await Bun.file(first.registryPath).json()) as {
      projects: Record<
        string,
        {
          locations: Array<{
            firstSeenAt: string;
            lastSeenAt: string;
            path: string;
          }>;
        }
      >;
    };
    registry.projects[firstPlan.identity.id]?.locations.push({
      path: alias,
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-01T00:00:00.000Z",
    });
    await writeFile(
      first.registryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8"
    );
    const aliasAiRoot = join(alias, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aliasAiRoot, home)
    );
    const legacyJournal = join(legacyState, "journal", "events.jsonl");
    await mkdir(dirname(legacyJournal), { recursive: true });
    await writeFile(legacyJournal, "persisted alias\n", "utf8");

    const secondPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    expect(secondPlan.legacyStateRoots).toContain(aliasAiRoot);
    expect(secondPlan.stateMigrations).toEqual([
      expect.objectContaining({ source: legacyState }),
    ]);

    await applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
    });

    expect(await pathEntryExists(legacyState)).toBe(false);
    expect(
      await readFile(
        join(
          facultMachineStateDir(home, join(repo, ".ai")),
          "journal",
          "events.jsonl"
        ),
        "utf8"
      )
    ).toBe("persisted alias\n");
  });

  it("deterministically merges disjoint legacy and selected machine state", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedState = facultMachineStateDir(home, aiRoot);
    const legacyJournal = join(legacyState, "journal", "events.jsonl");
    const selectedQueue = join(
      selectedState,
      "ai",
      "project",
      "writeback",
      "queue.jsonl"
    );
    await mkdir(dirname(legacyJournal), { recursive: true });
    await writeFile(legacyJournal, '{"legacy":true}\n', "utf8");
    await mkdir(dirname(selectedQueue), { recursive: true });
    await writeFile(selectedQueue, '{"selected":true}\n', "utf8");
    expect(() => facultMachineStateDir(home, aiRoot)).toThrow(
      "require enrollment reconciliation"
    );

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const migration = plan.stateMigrations.find(
      (candidate) => candidate.source === legacyState
    );
    expect(migration?.destination).toBe(selectedState);
    expect(migration?.strategy).toBe("merge-disjoint");
    expect(typeof migration?.sourceTreeSha256).toBe("string");
    expect(typeof migration?.destinationTreeSha256).toBe("string");

    let quarantinePath: string | null = null;
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
      afterLegacyStateQuarantine: async ({ quarantine, source }) => {
        quarantinePath = quarantine;
        expect(await pathEntryExists(source)).toBe(false);
        expect((await lstat(quarantine)).isDirectory()).toBe(true);
      },
    });

    expect(await pathEntryExists(legacyState)).toBe(false);
    expect(quarantinePath).not.toBeNull();
    if (!quarantinePath) {
      throw new Error("Expected legacy migration quarantine observation");
    }
    expect(await pathEntryExists(quarantinePath)).toBe(false);
    expect(
      await readFile(join(selectedState, "journal", "events.jsonl"), "utf8")
    ).toBe('{"legacy":true}\n');
    expect(await readFile(selectedQueue, "utf8")).toBe('{"selected":true}\n');
    expect(facultMachineStateDir(home, aiRoot)).toBe(selectedState);
  });

  it("fails closed when an enrolled checkout execution identity is temporarily unavailable", async () => {
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
    const aiRoot = join(repo, ".ai");
    const executionState = facultMachineStateDir(home, aiRoot);
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const originalPath = process.env.PATH;
    process.env.PATH = join(root, "missing-bin");
    try {
      expect(() => facultMachineStateDir(home, aiRoot)).toThrow(
        "Unable to resolve machine-local execution identity"
      );
    } finally {
      process.env.PATH = originalPath;
    }
    expect(await pathEntryExists(executionState)).toBe(true);
    expect(await pathEntryExists(legacyState)).toBe(false);
  });

  it("preserves legacy state selection for non-Git project config roots", async () => {
    const { root, home } = await makeFixture();
    const aiRoot = join(root, "non-git", ".ai");
    await mkdir(aiRoot, { recursive: true });
    await writeFile(
      join(aiRoot, "config.toml"),
      'version = 1\n\n[workspace]\nname = "local"\n',
      "utf8"
    );

    expect(facultMachineStateDir(home, aiRoot)).toBe(
      join(
        facultLocalStateRoot(home),
        "projects",
        legacyMachineStateProjectKey(aiRoot, home)
      )
    );
  });

  it("rejects unsafe or unreadable legacy state during path selection", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    await createRepository({ path: repo, home });
    await mkdir(outside, { recursive: true });
    const aiRoot = join(repo, ".ai");
    const projectsRoot = join(facultLocalStateRoot(home), "projects");
    const legacyState = join(
      projectsRoot,
      legacyMachineStateProjectKey(aiRoot, home)
    );
    await mkdir(projectsRoot, { recursive: true });
    await symlink(
      outside,
      legacyState,
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(() => facultMachineStateDir(home, aiRoot)).toThrow(
      "unsafe machine-local project state directory"
    );
    await rm(legacyState);

    await mkdir(legacyState, { recursive: true });
    if (process.platform !== "win32") {
      await chmod(projectsRoot, 0o000);
      try {
        let accessDenied = false;
        try {
          await lstat(legacyState);
        } catch (error) {
          accessDenied = Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "EACCES"
          );
        }
        if (accessDenied) {
          expect(() => facultMachineStateDir(home, aiRoot)).toThrow();
        }
      } finally {
        await chmod(projectsRoot, 0o700);
      }
    }
    await rm(legacyState, { recursive: true });
    const nonGitRoot = join(root, "non-git");
    const nonGitAiRoot = join(nonGitRoot, ".ai");
    await mkdir(join(nonGitAiRoot, "instructions"), { recursive: true });
    const nonGitState = join(
      projectsRoot,
      legacyMachineStateProjectKey(nonGitAiRoot, home)
    );
    await symlink(
      outside,
      nonGitState,
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(() => facultMachineStateDir(home, nonGitAiRoot)).toThrow(
      "unsafe machine-local project state directory"
    );
  });

  it("preserves a late legacy writer detected before quarantine", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedState = facultMachineStateDir(home, aiRoot);
    const legacyJournal = join(legacyState, "journal", "events.jsonl");
    const lateQueue = join(legacyState, "writeback", "late.jsonl");
    const selectedQueue = join(selectedState, "review", "queue.jsonl");
    await mkdir(dirname(legacyJournal), { recursive: true });
    await writeFile(legacyJournal, "legacy journal\n", "utf8");
    await mkdir(dirname(selectedQueue), { recursive: true });
    await writeFile(selectedQueue, "selected queue\n", "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        beforeLegacyStateQuarantine: async () => {
          await mkdir(dirname(lateQueue), { recursive: true });
          await writeFile(lateQueue, "late writer\n", "utf8");
        },
      })
    ).rejects.toThrow("changed before quarantine");

    expect(await readFile(legacyJournal, "utf8")).toBe("legacy journal\n");
    expect(await readFile(lateQueue, "utf8")).toBe("late writer\n");
    expect(await readFile(selectedQueue, "utf8")).toBe("selected queue\n");
    expect(
      await Bun.file(join(selectedState, "journal", "events.jsonl")).exists()
    ).toBe(false);
    expect(await Bun.file(aiRoot).exists()).toBe(false);
  });

  it("preserves a late legacy writer detected before rename commit", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const executionState = join(
      facultLocalStateRoot(home),
      "projects",
      (await resolveRepositoryExecutionIdentity(repo)).id
    );
    const legacyJournal = join(legacyState, "journal", "events.jsonl");
    const lateQueue = join(legacyState, "writeback", "late.jsonl");
    await mkdir(dirname(legacyJournal), { recursive: true });
    await writeFile(legacyJournal, "legacy journal\n", "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    expect(plan.stateMigrations).toEqual([
      expect.objectContaining({
        source: legacyState,
        destination: executionState,
        strategy: "rename",
      }),
    ]);

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterReceiptWrite: async () => {
          await mkdir(dirname(lateQueue), { recursive: true });
          await writeFile(lateQueue, "late writer\n", "utf8");
        },
      })
    ).rejects.toThrow("changed before commit");

    expect(await readFile(legacyJournal, "utf8")).toBe("legacy journal\n");
    expect(await readFile(lateQueue, "utf8")).toBe("late writer\n");
    expect(await pathEntryExists(executionState)).toBe(false);
    expect(await Bun.file(aiRoot).exists()).toBe(false);
    expect(
      await Bun.file(plan.machineLocalWrites[0]?.path ?? "").exists()
    ).toBe(false);
  });

  it("holds legacy runtime writer locks through the final state rename", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const legacyLock = join(
      legacyState,
      "ai/project/reconciliation/state.json.lock"
    );
    await mkdir(dirname(legacyLock), { recursive: true });
    await writeFile(
      join(legacyState, "ai/project/reconciliation/state.json"),
      "{}\n",
      "utf8"
    );
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    let competingWriterBlocked = false;

    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
      afterGeneratedWrites: async () => {
        try {
          const competitor = await open(legacyLock, "wx");
          await competitor.close();
        } catch (error) {
          competingWriterBlocked =
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EEXIST";
        }
      },
    });

    const selectedState = facultMachineStateDir(home, aiRoot);
    expect(competingWriterBlocked).toBe(true);
    expect((await lstat(legacyState)).isDirectory()).toBe(true);
    expect(
      await Bun.file(
        join(legacyState, "ai/project/reconciliation/state.json")
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(selectedState, "ai/project/reconciliation/state.json")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(selectedState, "ai/project/reconciliation/state.json.lock")
      ).exists()
    ).toBe(false);
    expect(
      (
        await planProjectEnrollment({
          projectRoot: repo,
          homeDir: home,
        })
      ).stateMigrations
    ).toEqual([]);
  });

  it("compensates a legacy source reappearance after quarantine", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedState = facultMachineStateDir(home, aiRoot);
    const legacyJournal = join(legacyState, "journal", "events.jsonl");
    const lateReview = join(legacyState, "review", "late.md");
    const selectedQueue = join(selectedState, "review", "queue.jsonl");
    await mkdir(dirname(legacyJournal), { recursive: true });
    await writeFile(legacyJournal, "legacy journal\n", "utf8");
    await mkdir(dirname(selectedQueue), { recursive: true });
    await writeFile(selectedQueue, "selected queue\n", "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterLegacyStateQuarantine: async ({ source }) => {
          await mkdir(dirname(lateReview), { recursive: true });
          await writeFile(lateReview, "late review\n", "utf8");
          expect(source).toBe(legacyState);
        },
      })
    ).rejects.toThrow("changed after quarantine");

    expect(await readFile(legacyJournal, "utf8")).toBe("legacy journal\n");
    expect(await readFile(lateReview, "utf8")).toBe("late review\n");
    expect(await readFile(selectedQueue, "utf8")).toBe("selected queue\n");
    expect(
      await Bun.file(join(selectedState, "journal", "events.jsonl")).exists()
    ).toBe(false);
    expect(
      (await readdir(dirname(legacyState))).some((name) =>
        name.includes(".fclt-quarantine-")
      )
    ).toBe(false);
    expect(await Bun.file(aiRoot).exists()).toBe(false);
  });

  it("rebuilds selected generated overlaps while preserving disjoint state", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedState = facultMachineStateDir(home, aiRoot);
    const legacyIndex = join(legacyState, "ai", "index.json");
    const legacyGraph = join(legacyState, "ai", "graph.json");
    const selectedIndex = facultAiIndexPath(home, aiRoot);
    const selectedGraph = facultAiGraphPath(home, aiRoot);
    const legacyJournal = join(legacyState, "journal", "events.jsonl");
    const selectedQueue = join(selectedState, "review", "queue.jsonl");
    for (const [pathValue, content] of [
      [legacyIndex, '{"legacy":"index"}\n'],
      [legacyGraph, '{"legacy":"graph"}\n'],
      [legacyJournal, "legacy journal\n"],
      [selectedIndex, '{"selected":"index"}\n'],
      [selectedGraph, '{"selected":"graph"}\n'],
      [selectedQueue, "selected queue\n"],
    ] as const) {
      await mkdir(dirname(pathValue), { recursive: true });
      await writeFile(pathValue, content, "utf8");
    }

    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const migration = plan.stateMigrations.find(
      (candidate) => candidate.source === legacyState
    );
    expect(migration?.rebuildableOverlaps).toEqual([
      "ai/graph.json",
      "ai/index.json",
    ]);

    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });

    expect(await Bun.file(legacyState).exists()).toBe(false);
    expect(JSON.parse(await readFile(selectedIndex, "utf8")).version).toBe(1);
    expect(JSON.parse(await readFile(selectedGraph, "utf8")).version).toBe(1);
    expect(
      await readFile(join(selectedState, "journal", "events.jsonl"), "utf8")
    ).toBe("legacy journal\n");
    expect(await readFile(selectedQueue, "utf8")).toBe("selected queue\n");
  });

  it("restores generated overlaps when a later enrollment step fails", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const legacyIndex = join(legacyState, "ai", "index.json");
    const selectedIndex = facultAiIndexPath(home, aiRoot);
    await mkdir(dirname(legacyIndex), { recursive: true });
    await writeFile(legacyIndex, "legacy generated\n", "utf8");
    await mkdir(dirname(selectedIndex), { recursive: true });
    await writeFile(selectedIndex, "selected generated\n", "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: () =>
          Promise.reject(new Error("injected generated-overlap failure")),
      })
    ).rejects.toThrow("injected generated-overlap failure");

    expect(await readFile(legacyIndex, "utf8")).toBe("legacy generated\n");
    expect(await readFile(selectedIndex, "utf8")).toBe("selected generated\n");
    expect(await Bun.file(aiRoot).exists()).toBe(false);
  });

  it("compensates a disjoint merge when later enrollment fails", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedState = facultMachineStateDir(home, aiRoot);
    const legacyFile = join(legacyState, "journal", "events.jsonl");
    const selectedFile = join(selectedState, "review", "queue.jsonl");
    await mkdir(dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, "legacy\n", "utf8");
    await mkdir(dirname(selectedFile), { recursive: true });
    await writeFile(selectedFile, "selected\n", "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: () =>
          Promise.reject(new Error("injected post-merge failure")),
      })
    ).rejects.toThrow("injected post-merge failure");

    expect(await readFile(legacyFile, "utf8")).toBe("legacy\n");
    expect(await readFile(selectedFile, "utf8")).toBe("selected\n");
    expect(
      await Bun.file(join(selectedState, "journal", "events.jsonl")).exists()
    ).toBe(false);
    expect(await Bun.file(aiRoot).exists()).toBe(false);
  });

  it("compensates completed legacy moves when later enrollment fails", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyKey = legacyMachineStateProjectKey(aiRoot, home);
    const legacyState = join(facultLocalStateRoot(home), "projects", legacyKey);
    const legacyReviews = ["writebacks", "evolution", "reconciliation"].map(
      (artifact) => join(home, ".ai", artifact, "projects", legacyKey)
    );
    for (const pathValue of [legacyState, ...legacyReviews]) {
      await mkdir(pathValue, { recursive: true });
      await writeFile(join(pathValue, "preserve.txt"), pathValue, "utf8");
    }
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: () =>
          Promise.reject(new Error("injected later enrollment failure")),
      })
    ).rejects.toThrow("injected later enrollment failure");

    const selectedPaths = [
      facultMachineStateDir(home, aiRoot),
      facultAiWritebackReviewDir(home, aiRoot),
      facultAiEvolutionReviewDir(home, aiRoot),
      facultAiReconciliationReviewDir(home, aiRoot),
    ];
    for (const pathValue of [legacyState, ...legacyReviews]) {
      expect(await readFile(join(pathValue, "preserve.txt"), "utf8")).toBe(
        pathValue
      );
    }
    for (const pathValue of selectedPaths) {
      expect(await Bun.file(pathValue).exists()).toBe(false);
    }
    expect(await Bun.file(aiRoot).exists()).toBe(false);
  });

  it("compensates earlier legacy moves when a later rename fails", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyKey = legacyMachineStateProjectKey(aiRoot, home);
    const legacyState = join(facultLocalStateRoot(home), "projects", legacyKey);
    const legacyReview = join(home, ".ai", "writebacks", "projects", legacyKey);
    for (const pathValue of [legacyState, legacyReview]) {
      await mkdir(pathValue, { recursive: true });
      await writeFile(join(pathValue, "preserve.txt"), pathValue, "utf8");
    }
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        beforeLegacyStateRename: ({ index }) =>
          index === 1
            ? Promise.reject(new Error("injected migration rename failure"))
            : Promise.resolve(),
      })
    ).rejects.toThrow("injected migration rename failure");
    for (const pathValue of [legacyState, legacyReview]) {
      expect(await readFile(join(pathValue, "preserve.txt"), "utf8")).toBe(
        pathValue
      );
    }
    expect(await Bun.file(facultMachineStateDir(home, aiRoot)).exists()).toBe(
      false
    );
    expect(
      await Bun.file(facultAiWritebackReviewDir(home, aiRoot)).exists()
    ).toBe(false);
  });

  it("fails closed when a moved destination is replaced before restore", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyState = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    await mkdir(legacyState, { recursive: true });
    await writeFile(join(legacyState, "preserve.txt"), "legacy\n", "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const selectedState =
      plan.stateMigrations.find((migration) => migration.source === legacyState)
        ?.destination ?? "";
    expect(selectedState).not.toBe("");
    const displacedState = `${selectedState}.displaced`;
    let replaced = false;

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: () =>
          Promise.reject(new Error("injected later failure")),
        beforeLegacyStateRestore: async ({ destination }) => {
          if (!replaced && destination === selectedState) {
            replaced = true;
            await rename(destination, displacedState);
            await mkdir(destination);
            await writeFile(
              join(destination, "replacement.txt"),
              "replacement\n",
              "utf8"
            );
          }
        },
      })
    ).rejects.toThrow("transaction cleanup was incomplete");
    expect(await Bun.file(legacyState).exists()).toBe(false);
    expect(await readFile(join(selectedState, "replacement.txt"), "utf8")).toBe(
      "replacement\n"
    );
    expect(await readFile(join(displacedState, "preserve.txt"), "utf8")).toBe(
      "legacy\n"
    );
  });

  it("fails closed when legacy and selected machine state both exist", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const legacyDir = join(
      facultLocalStateRoot(home),
      "projects",
      legacyMachineStateProjectKey(aiRoot, home)
    );
    const selectedDir = facultMachineStateDir(home, aiRoot);
    await mkdir(legacyDir, { recursive: true });
    await mkdir(selectedDir, { recursive: true });
    await writeFile(join(legacyDir, "managed.json"), "legacy\n", "utf8");
    await writeFile(join(selectedDir, "managed.json"), "selected\n", "utf8");
    await expect(
      planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      })
    ).rejects.toThrow("conflicting legacy and selected");
    expect(await readFile(join(legacyDir, "managed.json"), "utf8")).toBe(
      "legacy\n"
    );
    expect(await readFile(join(selectedDir, "managed.json"), "utf8")).toBe(
      "selected\n"
    );
    expect(await Bun.file(aiRoot).exists()).toBe(false);
  });

  it("refuses generated index and graph symlinks without touching their targets", async () => {
    for (const generatedIndex of [0, 1]) {
      const { root, home } = await makeFixture();
      const repo = join(root, `repo-${generatedIndex}`);
      const victim = join(root, `victim-${generatedIndex}.json`);
      await createRepository({ path: repo, home });
      await writeFile(victim, "user-owned\n", "utf8");
      const plan = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      });
      const generatedPath = plan.generatedWrites[generatedIndex]?.path;
      expect(generatedPath).toBeDefined();
      await mkdir(dirname(generatedPath ?? ""), { recursive: true });
      await symlink(victim, generatedPath ?? "");

      await expect(
        applyProjectEnrollment({
          plan,
          expectedPlanSha256: plan.planSha256,
          homeDir: home,
        })
      ).rejects.toThrow("symlinked machine-local state path");

      expect(await readFile(victim, "utf8")).toBe("user-owned\n");
      expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
    }
  });

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
      facultMachineStateDir(home, join(repo, ".ai")).endsWith(
        plan.executionIdentity.id
      )
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

  it("revalidates every canonical destination at its write boundary", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const userEdit = "version = 1\n\n[user]\nowned = true\n";

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        beforeCanonicalWrite: async ({ index }) => {
          if (index === 1) {
            await writeFile(join(repo, ".ai", "config.toml"), userEdit, "utf8");
          }
        },
      })
    ).rejects.toThrow("no-replace commit boundary");

    expect(await readFile(join(repo, ".ai", "config.toml"), "utf8")).toBe(
      userEdit
    );
    expect(await Bun.file(join(repo, ".ai", ".gitignore")).exists()).toBe(
      false
    );
  });

  it("compensates an existing canonical file swapped at the enrollment exchange boundary", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const configPath = join(aiRoot, "config.toml");
    const reviewedPath = join(aiRoot, "config.reviewed.toml");
    const reviewed = "version = 1\n\n[custom]\nowned = true\n";
    const concurrent = "version = 1\n\n[user]\nowned = true\n";
    await mkdir(aiRoot);
    await writeFile(configPath, reviewed, "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        beforeCanonicalWrite: async ({ path }) => {
          if (path !== configPath) {
            return;
          }
          await rename(configPath, reviewedPath);
          await writeFile(configPath, concurrent, "utf8");
        },
      })
    ).rejects.toThrow("commit boundary");

    expect(await readFile(configPath, "utf8")).toBe(concurrent);
    expect(await readFile(reviewedPath, "utf8")).toBe(reviewed);
    expect(await Bun.file(join(aiRoot, ".gitignore")).exists()).toBe(false);
    expect(
      (await readdir(aiRoot)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  });

  it("preserves a concurrent canonical edit when a later apply stage fails", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const concurrentEdit = "version = 1\n\n[user]\nowned = true\n";
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: async () => {
          await writeFile(
            join(repo, ".ai", "config.toml"),
            concurrentEdit,
            "utf8"
          );
          throw new Error("injected late failure");
        },
      })
    ).rejects.toThrow("injected late failure");

    expect(await readFile(join(repo, ".ai", "config.toml"), "utf8")).toBe(
      concurrentEdit
    );
    expect(await Bun.file(join(repo, ".ai", ".gitignore")).exists()).toBe(
      false
    );
    for (const generated of plan.generatedWrites) {
      expect(await Bun.file(generated.path).exists()).toBe(false);
    }
  });

  it("revalidates ownership at the cleanup restore commit boundary", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    await mkdir(join(repo, ".ai"), { recursive: true });
    const before = "version = 1\n\n[custom]\nowned = true\n";
    const concurrent = `${before}\n[user]\nlate = true\n`;
    const configPath = join(repo, ".ai", "config.toml");
    await writeFile(configPath, before, "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    let edited = false;
    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: () => Promise.reject(new Error("late failure")),
        beforeCleanupRestore: async ({ path }) => {
          if (!edited && path === configPath) {
            edited = true;
            await writeFile(configPath, concurrent, "utf8");
          }
        },
      })
    ).rejects.toThrow("cleanup was incomplete");
    expect(await readFile(configPath, "utf8")).toBe(concurrent);
  });

  it("preserves a fresh canonical leaf swapped during failed-apply cleanup", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const configPath = join(repo, ".ai", "config.toml");
    const displacedPath = join(repo, ".ai", "config.enrolled.toml");
    const replacement = "version = 1\n\n[user]\nowned = true\n";
    const enrolled = plan.canonicalWrites.find(
      (write) => write.path === configPath
    )?.content;
    if (!enrolled) {
      throw new Error("Expected a planned project config");
    }
    let swapped = false;

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: () =>
          Promise.reject(new Error("injected late apply failure")),
        beforeCleanupRestore: async ({ path }) => {
          if (swapped || path !== configPath) {
            return;
          }
          swapped = true;
          await rename(configPath, displacedPath);
          await writeFile(configPath, replacement, "utf8");
        },
      })
    ).rejects.toThrow("cleanup was incomplete");

    expect(swapped).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(replacement);
    expect(await readFile(displacedPath, "utf8")).toBe(enrolled);
    expect(
      (await readdir(join(repo, ".ai"))).filter((name) =>
        name.endsWith(".rollback")
      )
    ).toEqual([]);
  });

  it("fails closed when a failed-apply cleanup safe root is replaced", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const displacedRepo = join(root, "repo-enrolled");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const configPath = join(repo, ".ai", "config.toml");
    const replacement = "version = 1\n\n[user]\nowned = true\n";
    const enrolled = plan.canonicalWrites.find(
      (write) => write.path === configPath
    )?.content;
    if (!enrolled) {
      throw new Error("Expected a planned project config");
    }
    let swapped = false;

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: () =>
          Promise.reject(new Error("injected late apply failure")),
        beforeCleanupRestore: async ({ path }) => {
          if (swapped || path !== configPath) {
            return;
          }
          swapped = true;
          await rename(repo, displacedRepo);
          await mkdir(join(repo, ".ai"), { recursive: true });
          await writeFile(configPath, replacement, "utf8");
        },
      })
    ).rejects.toThrow("cleanup was incomplete");

    expect(swapped).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(replacement);
    expect(
      await readFile(join(displacedRepo, ".ai", "config.toml"), "utf8")
    ).toBe(enrolled);
  });

  it("cleans generated state, registry, and receipt after a final verification failure", async () => {
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
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterReceiptWrite: () =>
          Promise.reject(new Error("injected final verification failure")),
      })
    ).rejects.toThrow("injected final verification failure");

    expect(await Bun.file(join(repo, ".ai", ".gitignore")).exists()).toBe(
      false
    );
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      false
    );
    for (const generated of plan.generatedWrites) {
      expect(await Bun.file(generated.path).exists()).toBe(false);
    }
    const registryPath = plan.machineLocalWrites[0]?.path ?? "";
    expect(await Bun.file(registryPath).exists()).toBe(false);
    const receiptFiles = await readdir(
      join(dirname(registryPath), "receipts")
    ).catch(() => []);
    expect(receiptFiles.filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("propagates non-ENOENT metadata errors during transaction snapshots", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const aiRoot = join(repo, ".ai");
    const displacedAiRoot = join(repo, ".ai-enrolled");
    let thrown: unknown;

    try {
      await applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        afterGeneratedWrites: async () => {
          await rename(aiRoot, displacedAiRoot);
          await writeFile(aiRoot, "not a directory\n", "utf8");
          throw new Error("injected metadata failure");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(
      errors.some(
        (error) => (error as NodeJS.ErrnoException).code === "ENOTDIR"
      )
    ).toBe(true);
    expect(await readFile(aiRoot, "utf8")).toBe("not a directory\n");
    expect(await readFile(join(displacedAiRoot, "config.toml"), "utf8")).toBe(
      plan.canonicalWrites[1]?.content ?? ""
    );
  });

  it("preserves a non-cooperating registry edit at the final commit boundary", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const registryPath = plan.machineLocalWrites[0]?.path ?? "";
    const concurrentRegistry = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-07-28T12:30:00.000Z",
        projects: {},
      },
      null,
      2
    )}\n`;

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        beforeRegistryWrite: async () => {
          await writeFile(registryPath, concurrentRegistry, "utf8");
        },
      })
    ).rejects.toThrow("commit boundary");

    expect(await readFile(registryPath, "utf8")).toBe(concurrentRegistry);
    expect(await Bun.file(join(repo, ".ai", ".gitignore")).exists()).toBe(
      false
    );
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      false
    );
    for (const generated of plan.generatedWrites) {
      expect(await Bun.file(generated.path).exists()).toBe(false);
    }
    const receiptFiles = await readdir(
      join(dirname(registryPath), "receipts")
    ).catch(() => []);
    expect(receiptFiles.filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("preserves a registry replacement at the conditional exchange boundary", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const registryPath = plan.machineLocalWrites[0]?.path ?? "";
    const initialRegistry = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-07-28T12:00:00.000Z",
        projects: {},
      },
      null,
      2
    )}\n`;
    const concurrentRegistry = initialRegistry.replace(
      "2026-07-28T12:00:00.000Z",
      "2026-07-28T12:30:00.000Z"
    );
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, initialRegistry, "utf8");

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        beforeRegistryExchange: async () => {
          await writeFile(registryPath, concurrentRegistry, "utf8");
        },
      })
    ).rejects.toThrow("conditional commit boundary");

    expect(await readFile(registryPath, "utf8")).toBe(concurrentRegistry);
    expect(await Bun.file(join(repo, ".ai", ".gitignore")).exists()).toBe(
      false
    );
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      false
    );
    for (const generated of plan.generatedWrites) {
      expect(await Bun.file(generated.path).exists()).toBe(false);
    }
    const receiptFiles = await readdir(
      join(dirname(registryPath), "receipts")
    ).catch(() => []);
    expect(receiptFiles.filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("serializes duplicate exact plans so one transaction wins without losing registry history", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    const results = await Promise.allSettled([
      applyProjectEnrollment({
        plan: firstPlan,
        expectedPlanSha256: firstPlan.planSha256,
        homeDir: home,
      }),
      applyProjectEnrollment({
        plan: secondPlan,
        expectedPlanSha256: secondPlan.planSha256,
        homeDir: home,
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    const applied = results.find((result) => result.status === "fulfilled");
    if (applied?.status !== "fulfilled") {
      throw new Error("Expected one enrollment transaction to succeed");
    }
    const registry = (await Bun.file(applied.value.registryPath).json()) as {
      projects: Record<string, { history: Array<{ action: string }> }>;
    };
    expect(
      registry.projects[firstPlan.identity.id]?.history.filter(
        (event) => event.action === "enrolled"
      )
    ).toHaveLength(1);
  });

  it("uses a bindable mutation socket when the platform temp path is long", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    let endpoint: string | undefined;

    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
      beforeCanonicalWrite: async () => {
        const owner = JSON.parse(
          await readFile(
            join(
              facultLocalStateRoot(home),
              "projects",
              "mutation.lock",
              "owner.json"
            ),
            "utf8"
          )
        ) as { endpoint?: string };
        endpoint = owner.endpoint;
      },
    });

    expect(endpoint).toBeDefined();
    if (process.platform !== "win32") {
      expect(Buffer.byteLength(endpoint!)).toBeLessThanOrEqual(96);
    }
  });

  it("refuses an older receipt after a newer enrollment of the same checkout", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const first = await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const second = await applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T13:00:00.000Z"),
    });

    await expect(
      rollbackProjectEnrollment({
        receiptId: first.receiptId,
        homeDir: home,
        apply: true,
      })
    ).rejects.toThrow("not the active enrollment");
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      true
    );
    expect(second.receiptId).not.toBe(first.receiptId);
  });

  it("serializes apply against rollback so only one receipt transition wins", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const initialPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const initial = await applyProjectEnrollment({
      plan: initialPlan,
      expectedPlanSha256: initialPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    const nextPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });

    const results = await Promise.allSettled([
      applyProjectEnrollment({
        plan: nextPlan,
        expectedPlanSha256: nextPlan.planSha256,
        homeDir: home,
        now: new Date("2026-07-28T13:00:00.000Z"),
      }),
      rollbackProjectEnrollment({
        receiptId: initial.receiptId,
        homeDir: home,
        apply: true,
        now: new Date("2026-07-28T13:00:00.000Z"),
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    const registry = (await Bun.file(initial.registryPath).json()) as {
      projects: Record<string, { history: Array<{ action: string }> }>;
    };
    expect(registry.projects[initialPlan.identity.id]?.history).toHaveLength(2);
  });

  it("reclaims an abandoned mutation lock while excluding a live owner", async () => {
    const { root, home } = await makeFixture();
    const firstRepo = join(root, "first");
    const secondRepo = join(root, "second");
    await createRepository({ path: firstRepo, home });
    await createRepository({ path: secondRepo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: firstRepo,
      homeDir: home,
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: secondRepo,
      homeDir: home,
    });
    const lockPath =
      firstPlan.machineLocalWrites.find((write) =>
        write.path.endsWith("mutation.lock")
      )?.path ?? "";
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 2,
        endpoint: join(tmpdir(), "fclt-abandoned-owner.sock"),
        ownerId: "abandoned-owner",
        pid: 999_999,
        acquiredAt: "2026-07-28T00:00:00.000Z",
        transport: "ipc-socket",
      })}\n`,
      "utf8"
    );

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstApply = applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
      afterGeneratedWrites: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const liveOwner = (await Bun.file(join(lockPath, "owner.json")).json()) as {
      pid: number;
      transport: string;
    };
    expect(liveOwner).toMatchObject({
      pid: process.pid,
      transport: "ipc-socket",
    });

    let secondSettled = false;
    const secondApply = applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
    }).finally(() => {
      secondSettled = true;
    });
    await Bun.sleep(50);
    expect(secondSettled).toBe(false);
    release.resolve();

    await Promise.all([firstApply, secondApply]);
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  it("does not expose observation races during concurrent abandoned-lock recovery", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const lockPath =
      plan.machineLocalWrites.find((write) =>
        write.path.endsWith("mutation.lock")
      )?.path ?? "";
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 2,
        endpoint: join(tmpdir(), "fclt-concurrent-abandoned-owner.sock"),
        ownerId: "concurrent-abandoned-owner",
        pid: 999_999,
        acquiredAt: "2026-07-28T00:00:00.000Z",
        transport: "ipc-socket",
      })}\n`,
      "utf8"
    );

    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        applyProjectEnrollment({
          plan,
          expectedPlanSha256: plan.planSha256,
          homeDir: home,
        })
      )
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejected).toHaveLength(24);
    expect(
      rejected.every(
        (result) =>
          result.reason instanceof Error &&
          result.reason.message.includes("Enrollment plan is stale")
      )
    ).toBe(true);
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  it("fails safe when a live owner is IPC-unresponsive or its PID was reused", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const lockPath =
      plan.machineLocalWrites.find((write) =>
        write.path.endsWith("mutation.lock")
      )?.path ?? "";
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 2,
        endpoint: join(tmpdir(), "fclt-recycled-pid-owner.sock"),
        ownerId: "recycled-pid-owner",
        pid: process.pid,
        acquiredAt: "2026-07-28T00:00:00.000Z",
        transport: "ipc-socket",
      })}\n`,
      "utf8"
    );

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        mutationLockAttempts: 3,
      })
    ).rejects.toThrow("still in progress");
  });

  it("does not reclaim an ownerless mutation lock after initialization delay", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const lockPath =
      plan.machineLocalWrites.find((write) =>
        write.path.endsWith("mutation.lock")
      )?.path ?? "";
    await mkdir(lockPath, { recursive: true });
    const old = new Date("2026-07-28T00:00:00.000Z");
    await utimes(lockPath, old, old);

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        mutationLockAttempts: 3,
      })
    ).rejects.toThrow("still in progress");
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
  });

  it("refuses a symlinked mutation-lock owner without reclaiming the lock", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outsideOwner = join(root, "outside-owner.json");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const lockPath =
      plan.machineLocalWrites.find((write) =>
        write.path.endsWith("mutation.lock")
      )?.path ?? "";
    await mkdir(lockPath, { recursive: true });
    await writeFile(outsideOwner, '{"version":2}\n', "utf8");
    await symlink(outsideOwner, join(lockPath, "owner.json"));

    await expect(
      applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
        mutationLockAttempts: 1,
      })
    ).rejects.toThrow("Refusing unsafe canonical file");
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect(await readFile(outsideOwner, "utf8")).toBe('{"version":2}\n');
  });

  it("releases the mutation lock before sequential operations resolve", async () => {
    const { root, home } = await makeFixture();
    for (let index = 0; index < 4; index += 1) {
      const repo = join(root, `sequential-${index}`);
      await createRepository({
        path: repo,
        home,
        files: { "README.md": `# Sequential ${index}\n` },
      });
      const plan = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      });
      const lockPath =
        plan.machineLocalWrites.find((write) =>
          write.path.endsWith("mutation.lock")
        )?.path ?? "";
      const applied = await applyProjectEnrollment({
        plan,
        expectedPlanSha256: plan.planSha256,
        homeDir: home,
      });
      expect(await Bun.file(lockPath).exists()).toBe(false);

      const rolledBack = await rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
        apply: true,
      });
      expect(rolledBack.applied).toBe(true);
      expect(await Bun.file(lockPath).exists()).toBe(false);
    }
  });

  it("rolls back a fresh enrollment through the Windows-safe removal path", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "windows-rollback");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const applied = await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });
    const configPath = join(repo, ".ai", "config.toml");
    const ignorePath = join(repo, ".ai", ".gitignore");

    const rolledBack = await rollbackProjectEnrollment({
      receiptId: applied.receiptId,
      homeDir: home,
      apply: true,
      removalPlatform: "win32",
    });

    expect(rolledBack.applied).toBe(true);
    expect(await Bun.file(configPath).exists()).toBe(false);
    expect(await Bun.file(ignorePath).exists()).toBe(false);
    expect(
      (await readdir(join(repo, ".ai"))).filter(
        (name) => name.endsWith(".rollback") || name.endsWith(".preserved")
      )
    ).toEqual([]);
  });

  it("ignores occupied TCP ports and isolates distinct state roots", async () => {
    const { root, home } = await makeFixture();
    const otherHome = join(root, "other-home");
    const firstRepo = join(root, "first-repo");
    const secondRepo = join(root, "second-repo");
    await mkdir(otherHome, { recursive: true });
    await createRepository({ path: firstRepo, home });
    await createRepository({ path: secondRepo, home: otherHome });
    const firstPlan = await planProjectEnrollment({
      projectRoot: firstRepo,
      homeDir: home,
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: secondRepo,
      homeDir: otherHome,
    });
    const unrelated = createServer((socket) => socket.end("unrelated\n"));
    await new Promise<void>((resolvePromise, rejectPromise) => {
      unrelated.once("error", rejectPromise);
      unrelated.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () =>
        resolvePromise()
      );
    });
    try {
      const [first, second] = await Promise.all([
        applyProjectEnrollment({
          plan: firstPlan,
          expectedPlanSha256: firstPlan.planSha256,
          homeDir: home,
        }),
        applyProjectEnrollment({
          plan: secondPlan,
          expectedPlanSha256: secondPlan.planSha256,
          homeDir: otherHome,
        }),
      ]);
      expect(first.applied).toBe(true);
      expect(second.applied).toBe(true);
      for (const plan of [firstPlan, secondPlan]) {
        expect(
          await Bun.file(
            plan.machineLocalWrites.find((write) =>
              write.path.endsWith("mutation.lock")
            )?.path ?? ""
          ).exists()
        ).toBe(false);
      }
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        unrelated.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    }
  });

  it("preserves a legacy root primary with common-dir proof while adding the remote alias", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/migrated.git",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const rootAlias = plan.identity.aliases.find(
      (alias) => alias.kind === "root-commit"
    );
    if (!rootAlias) {
      throw new Error("Expected a root-commit migration alias");
    }
    const commonAlias = plan.identity.aliases.find(
      (alias) => alias.kind === "git-common-dir"
    );
    if (!commonAlias) {
      throw new Error("Expected a git-common-dir migration alias");
    }
    const registryPath = plan.machineLocalWrites[0]?.path ?? "";
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-07-27T12:00:00.000Z",
          projects: {
            [rootAlias.id]: {
              repositoryId: rootAlias.id,
              aliases: [commonAlias.id],
              identityKind: "root-commit",
              identityFingerprint: rootAlias.fingerprint,
              decision: "disabled",
              sources: ["git"],
              cadence: "on-demand",
              scheduling: false,
              guidance: [],
              locations: [
                {
                  path: repo,
                  firstSeenAt: "2026-07-27T12:00:00.000Z",
                  lastSeenAt: "2026-07-27T12:00:00.000Z",
                },
              ],
              lastSuccessfulRun: null,
              pendingApprovals: [],
              history: [
                {
                  at: "2026-07-27T12:00:00.000Z",
                  action: "disabled",
                  root: repo,
                },
              ],
            },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const migratedPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const applied = await applyProjectEnrollment({
      plan: migratedPlan,
      expectedPlanSha256: migratedPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    const registry = (await Bun.file(applied.registryPath).json()) as {
      projects: Record<
        string,
        { aliases: string[]; history: Array<{ action: string }> }
      >;
    };

    expect(migratedPlan.identity.id).toBe(rootAlias.id);
    expect(Object.keys(registry.projects)).toEqual([rootAlias.id]);
    expect(registry.projects[rootAlias.id]?.aliases).toContain(
      plan.identity.id
    );
    expect(
      registry.projects[rootAlias.id]?.history.map((event) => event.action)
    ).toEqual(["disabled", "enrolled"]);
  });

  it("matches a recorded portable alias when enrolling a separate clone", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const clone = join(root, "clone");
    const origin = "https://github.com/example/portable-alias.git";
    await createRepository({ path: repo, home });
    const initialPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const initial = await applyProjectEnrollment({
      plan: initialPlan,
      expectedPlanSha256: initialPlan.planSha256,
      homeDir: home,
    });
    await runFixtureGit({
      argv: ["remote", "add", "origin", origin],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    const remotePlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: remotePlan,
      expectedPlanSha256: remotePlan.planSha256,
      homeDir: home,
    });
    await runFixtureGit({
      argv: ["clone", repo, clone],
      repoDir: clone,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: ["remote", "set-url", "origin", origin],
      repoDir: clone,
      homeDir: home,
      cwd: clone,
    });

    const clonePlan = await planProjectEnrollment({
      projectRoot: clone,
      homeDir: home,
    });
    const cloneExecutionIdentity =
      await resolveRepositoryExecutionIdentity(clone);
    expect(remotePlan.identity.id).toBe(initialPlan.identity.id);
    expect(clonePlan.identity.id).toBe(initialPlan.identity.id);
    expect(clonePlan.executionIdentity.id).toBe(cloneExecutionIdentity.id);
    expect(clonePlan.executionIdentity.id).not.toBe(
      initialPlan.executionIdentity.id
    );
    await applyProjectEnrollment({
      plan: clonePlan,
      expectedPlanSha256: clonePlan.planSha256,
      homeDir: home,
    });
    const registry = (await Bun.file(initial.registryPath).json()) as {
      projects: Record<string, { locations: Array<{ path: string }> }>;
    };
    expect(Object.keys(registry.projects)).toEqual([initialPlan.identity.id]);
    expect(
      registry.projects[initialPlan.identity.id]?.locations.map(
        (location) => location.path
      )
    ).toEqual([clone, repo].sort());
  });

  it("uses distinct execution state and preserves registry history for concurrent clone and worktree enrollment", async () => {
    const { root, home } = await makeFixture();
    const source = join(root, "source");
    const clone = join(root, "clone");
    const worktree = join(root, "worktree");
    await createRepository({ path: source, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/enrollment-project.git",
      ],
      repoDir: source,
      homeDir: home,
      cwd: source,
    });
    await runFixtureGit({
      argv: ["clone", source, clone],
      repoDir: clone,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/enrollment-project.git",
      ],
      repoDir: clone,
      homeDir: home,
      cwd: clone,
    });
    await runFixtureGit({
      argv: ["worktree", "add", "-b", "enrollment-worktree", worktree],
      repoDir: source,
      homeDir: home,
      cwd: source,
    });
    const clonePlan = await planProjectEnrollment({
      projectRoot: clone,
      homeDir: home,
    });
    const worktreePlan = await planProjectEnrollment({
      projectRoot: worktree,
      homeDir: home,
    });

    expect(clonePlan.identity.id).toBe(worktreePlan.identity.id);
    expect(clonePlan.executionIdentity.id).not.toBe(
      worktreePlan.executionIdentity.id
    );
    expect(clonePlan.generatedWrites.map((write) => write.path)).not.toEqual(
      worktreePlan.generatedWrites.map((write) => write.path)
    );
    const [cloneResult, worktreeResult] = await Promise.all([
      applyProjectEnrollment({
        plan: clonePlan,
        expectedPlanSha256: clonePlan.planSha256,
        homeDir: home,
      }),
      applyProjectEnrollment({
        plan: worktreePlan,
        expectedPlanSha256: worktreePlan.planSha256,
        homeDir: home,
      }),
    ]);
    const registry = (await Bun.file(cloneResult.registryPath).json()) as {
      projects: Record<
        string,
        {
          activeReceipts: Record<string, string>;
          history: Array<{ action: string }>;
          locations: Array<{ path: string }>;
        }
      >;
    };
    const entry = registry.projects[clonePlan.identity.id];
    expect(entry?.locations.map((location) => location.path).sort()).toEqual(
      [clone, worktree].sort()
    );
    expect(
      entry?.history.filter((event) => event.action === "enrolled")
    ).toHaveLength(2);
    expect(worktreeResult.registryPath).toBe(cloneResult.registryPath);

    let status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [clone, worktree],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "covered",
      health: "healthy",
    });
    const nonPrimaryRoot =
      status.projects[0]?.canonicalRoot === join(clone, ".ai")
        ? worktree
        : clone;
    const nonPrimaryAiRoot = join(nonPrimaryRoot, ".ai");
    const configPath = join(nonPrimaryAiRoot, "config.toml");
    const ignorePath = join(nonPrimaryAiRoot, ".gitignore");
    const indexPath = facultAiIndexPath(home, nonPrimaryAiRoot);
    const graphPath = facultAiGraphPath(home, nonPrimaryAiRoot);
    const [configContent, ignoreContent, indexContent, graphContent] =
      await Promise.all([
        readFile(configPath),
        readFile(ignorePath),
        readFile(indexPath),
        readFile(graphPath),
      ]);

    await rm(configPath);
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [clone, worktree],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "partial",
      health: "degraded",
      canonical: { config: false },
    });
    await writeFile(configPath, configContent);

    await writeFile(ignorePath, "", "utf8");
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [clone, worktree],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "partial",
      health: "degraded",
      canonical: { protectiveIgnore: false },
    });
    await writeFile(ignorePath, ignoreContent);

    await writeFile(indexPath, "{}", "utf8");
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [clone, worktree],
    });
    expect(status.projects[0]).toMatchObject({
      health: "degraded",
      generated: { index: false, graph: true, health: "missing" },
    });
    await writeFile(indexPath, indexContent);

    await writeFile(graphPath, "{}", "utf8");
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [clone, worktree],
    });
    expect(status.projects[0]).toMatchObject({
      health: "degraded",
      generated: { index: true, graph: false, health: "missing" },
    });
    await writeFile(graphPath, graphContent);

    const missingRoot = join(root, "missing-active-checkout");
    if (!entry) {
      throw new Error("Expected the shared registry entry");
    }
    entry.activeReceipts[missingRoot] = cloneResult.receiptId;
    await writeFile(
      cloneResult.registryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8"
    );
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [clone, worktree],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "partial",
      health: "degraded",
      locations: expect.arrayContaining([
        expect.objectContaining({ path: missingRoot, exists: false }),
      ]),
    });
    delete entry.activeReceipts[missingRoot];
    await writeFile(
      cloneResult.registryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8"
    );

    const primaryRoot = nonPrimaryRoot === clone ? worktree : clone;
    await rm(nonPrimaryRoot, { recursive: true });
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [primaryRoot],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "partial",
      health: "degraded",
      locations: expect.arrayContaining([
        expect.objectContaining({ path: nonPrimaryRoot, exists: false }),
      ]),
    });
  });

  it("retires a stale active receipt when an enrolled checkout moves", async () => {
    const { root, home } = await makeFixture();
    const initialRoot = join(root, "before");
    const renamedRoot = join(root, "after");
    await createRepository({ path: initialRoot, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/moved-enrollment.git",
      ],
      repoDir: initialRoot,
      homeDir: home,
      cwd: initialRoot,
    });
    const initialPlan = await planProjectEnrollment({
      projectRoot: initialRoot,
      homeDir: home,
    });
    const initial = await applyProjectEnrollment({
      plan: initialPlan,
      expectedPlanSha256: initialPlan.planSha256,
      homeDir: home,
    });
    const initialState = join(
      facultLocalStateRoot(home),
      "projects",
      initialPlan.executionIdentity.id
    );
    const journalPath = join(initialState, "journal", "events.jsonl");
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(journalPath, "preserve-after-move\n", "utf8");

    await rename(initialRoot, renamedRoot);
    await symlink(
      renamedRoot,
      initialRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
    const renamedPlan = await planProjectEnrollment({
      projectRoot: renamedRoot,
      homeDir: home,
    });
    const renamedState = join(
      facultLocalStateRoot(home),
      "projects",
      renamedPlan.executionIdentity.id
    );
    expect(renamedPlan.executionIdentity.id).toBe(
      initialPlan.executionIdentity.id
    );
    expect(renamedState).toBe(initialState);
    const renamed = await applyProjectEnrollment({
      plan: renamedPlan,
      expectedPlanSha256: renamedPlan.planSha256,
      homeDir: home,
    });
    expect(
      await readFile(join(renamedState, "journal", "events.jsonl"), "utf8")
    ).toBe("preserve-after-move\n");
    const readActiveReceipts = async () => {
      const registry = (await Bun.file(renamed.registryPath).json()) as {
        projects: Record<string, { activeReceipts: Record<string, string> }>;
      };
      return registry.projects[renamedPlan.identity.id]?.activeReceipts;
    };
    expect(await readActiveReceipts()).toEqual({
      [renamedRoot]: renamed.receiptId,
    });
    expect(
      (
        await buildProjectsStatus({
          homeDir: home,
        })
      ).projects[0]
    ).toMatchObject({ coverage: "covered", health: "healthy" });

    await rollbackProjectEnrollment({
      receiptId: renamed.receiptId,
      homeDir: home,
      apply: true,
    });
    expect(await readActiveReceipts()).toEqual({});
    expect(
      (
        await buildProjectsStatus({
          homeDir: home,
        })
      ).projects[0]
    ).toMatchObject({ coverage: "covered", health: "healthy" });
    expect(initial.receiptId).not.toBe(renamed.receiptId);
  });

  it("retires a moved receipt when its old path is reused by a sibling clone", async () => {
    const { root, home } = await makeFixture();
    const initialRoot = join(root, "before");
    const renamedRoot = join(root, "after");
    const origin = "https://github.com/example/reused-moved-path.git";
    await createRepository({ path: initialRoot, home });
    await runFixtureGit({
      argv: ["remote", "add", "origin", origin],
      repoDir: initialRoot,
      homeDir: home,
      cwd: initialRoot,
    });
    const initialPlan = await planProjectEnrollment({
      projectRoot: initialRoot,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: initialPlan,
      expectedPlanSha256: initialPlan.planSha256,
      homeDir: home,
    });

    await rename(initialRoot, renamedRoot);
    await runFixtureGit({
      argv: ["clone", renamedRoot, initialRoot],
      repoDir: initialRoot,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: ["remote", "set-url", "origin", origin],
      repoDir: initialRoot,
      homeDir: home,
      cwd: initialRoot,
    });
    const [renamedExecution, siblingExecution] = await Promise.all([
      resolveRepositoryExecutionIdentity(renamedRoot),
      resolveRepositoryExecutionIdentity(initialRoot),
    ]);
    expect(siblingExecution.id).not.toBe(renamedExecution.id);

    const renamedPlan = await planProjectEnrollment({
      projectRoot: renamedRoot,
      homeDir: home,
    });
    const renamed = await applyProjectEnrollment({
      plan: renamedPlan,
      expectedPlanSha256: renamedPlan.planSha256,
      homeDir: home,
    });
    const registry = (await Bun.file(renamed.registryPath).json()) as {
      projects: Record<string, { activeReceipts: Record<string, string> }>;
    };

    expect(registry.projects[renamedPlan.identity.id]?.activeReceipts).toEqual({
      [renamedRoot]: renamed.receiptId,
    });
  });

  it("preserves another checkout receipt when repository inspection is inconclusive", async () => {
    const { root, home } = await makeFixture();
    const source = join(root, "source");
    const firstClone = join(root, "first");
    const secondClone = join(root, "second");
    const origin = "https://github.com/example/inconclusive-receipt.git";
    await createRepository({ path: source, home });
    await runFixtureGit({
      argv: ["remote", "add", "origin", origin],
      repoDir: source,
      homeDir: home,
      cwd: source,
    });
    for (const clone of [firstClone, secondClone]) {
      await runFixtureGit({
        argv: ["clone", source, clone],
        repoDir: clone,
        homeDir: home,
        cwd: root,
      });
      await runFixtureGit({
        argv: ["remote", "set-url", "origin", origin],
        repoDir: clone,
        homeDir: home,
        cwd: clone,
      });
    }
    const firstPlan = await planProjectEnrollment({
      projectRoot: firstClone,
      homeDir: home,
    });
    const first = await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: secondClone,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
    });
    const registryBefore = await readFile(first.registryPath, "utf8");
    const gitDir = join(firstClone, ".git");
    const savedGitDir = join(firstClone, ".git.saved");
    await rename(gitDir, savedGitDir);
    await writeFile(gitDir, "gitdir: /definitely/missing/git-dir\n", "utf8");
    try {
      await expect(buildProjectsStatus({ homeDir: home })).rejects.toThrow(
        "Git repository inspection failed"
      );
      const reEnrollment = await planProjectEnrollment({
        projectRoot: secondClone,
        homeDir: home,
        cadence: "weekly",
      });
      await expect(
        applyProjectEnrollment({
          plan: reEnrollment,
          expectedPlanSha256: reEnrollment.planSha256,
          homeDir: home,
        })
      ).rejects.toThrow("Git repository inspection failed");
      expect(await readFile(first.registryPath, "utf8")).toBe(registryBefore);
    } finally {
      await rm(gitDir);
      await rename(savedGitDir, gitDir);
    }
  });

  it("does not trust a checked-in repository id for machine-state isolation", async () => {
    const { root, home } = await makeFixture();
    const victim = join(root, "victim");
    const attacker = join(root, "attacker");
    await createRepository({ path: victim, home });
    await createRepository({
      path: attacker,
      home,
      files: { "README.md": "# Different root commit\n" },
    });
    const victimIdentity = await resolveRepositoryIdentity(victim);
    const attackerIdentity = await resolveRepositoryIdentity(attacker);
    const attackerExecution =
      await resolveRepositoryExecutionIdentity(attacker);
    expect(attackerIdentity.id).not.toBe(victimIdentity.id);
    await mkdir(join(attacker, ".ai"), { recursive: true });
    await writeFile(
      join(attacker, ".ai", "config.toml"),
      [
        "version = 1",
        "",
        "[project]",
        `repository_id = "${victimIdentity.id}"`,
        "",
      ].join("\n"),
      "utf8"
    );

    expect(
      facultMachineStateDir(home, join(attacker, ".ai")).endsWith(
        victimIdentity.id
      )
    ).toBe(false);

    await writeFile(
      join(attacker, ".ai", "config.toml"),
      [
        "version = 1",
        "",
        "[project]",
        `repository_id = "${attackerIdentity.id}"`,
        "",
      ].join("\n"),
      "utf8"
    );
    expect(
      facultMachineStateDir(home, join(attacker, ".ai")).endsWith(
        attackerExecution.id
      )
    ).toBe(true);
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

  it("rejects symlinked and oversized enrollment receipts before rollback", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outsideReceipt = join(root, "outside-receipt.json");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const applied = await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });
    const receiptPath = join(
      dirname(applied.registryPath),
      "receipts",
      `${applied.receiptId}.json`
    );
    const receipt = await readFile(receiptPath, "utf8");
    const configPath = join(repo, ".ai", "config.toml");
    const config = await readFile(configPath, "utf8");
    const registry = await readFile(applied.registryPath, "utf8");
    await rename(receiptPath, outsideReceipt);
    await symlink(outsideReceipt, receiptPath);

    for (const apply of [false, true]) {
      await expect(
        rollbackProjectEnrollment({
          receiptId: applied.receiptId,
          homeDir: home,
          apply,
        })
      ).rejects.toThrow("Refusing unsafe canonical file");
    }
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await readFile(applied.registryPath, "utf8")).toBe(registry);

    await rm(receiptPath);
    await writeFile(receiptPath, receipt, "utf8");
    await truncate(receiptPath, 24 * 1024 * 1024 + 1);
    await expect(
      rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
      })
    ).rejects.toThrow("Refusing unsafe canonical file");
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await readFile(applied.registryPath, "utf8")).toBe(registry);
  });

  it("restores the previous registry entry and receipt linkage after re-enrollment rollback", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      sources: ["git"],
      cadence: "on-demand",
    });
    const first = await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      sources: ["git"],
      cadence: "on-demand",
    });
    const second = await applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T13:00:00.000Z"),
    });

    await rollbackProjectEnrollment({
      receiptId: second.receiptId,
      homeDir: home,
      apply: true,
      now: new Date("2026-07-28T14:00:00.000Z"),
    });

    const registry = (await Bun.file(second.registryPath).json()) as {
      projects: Record<
        string,
        {
          activeReceipts: Record<string, string>;
          cadence: string;
          decision: string;
          history: Array<{ action: string; receiptId?: string }>;
          locations: Array<{
            firstSeenAt: string;
            lastSeenAt: string;
            path: string;
          }>;
          sources: string[];
        }
      >;
    };
    const entry = registry.projects[firstPlan.identity.id];
    expect(entry).toMatchObject({
      activeReceipts: { [repo]: first.receiptId },
      cadence: "on-demand",
      decision: "selected",
      sources: ["git"],
    });
    expect(entry?.locations).toEqual([
      {
        path: repo,
        firstSeenAt: "2026-07-28T12:00:00.000Z",
        lastSeenAt: "2026-07-28T12:00:00.000Z",
      },
    ]);
    expect(entry?.history.map((event) => event.action)).toEqual([
      "enrolled",
      "enrolled",
      "rolled-back",
    ]);
    expect(entry?.history.map((event) => event.receiptId)).toEqual([
      first.receiptId,
      second.receiptId,
      second.receiptId,
    ]);

    const firstRollback = await rollbackProjectEnrollment({
      receiptId: first.receiptId,
      homeDir: home,
      apply: true,
      now: new Date("2026-07-28T15:00:00.000Z"),
    });
    expect(firstRollback.applied).toBe(true);
    expect(await Bun.file(join(repo, ".ai", "config.toml")).exists()).toBe(
      false
    );
  });

  it("preserves later lifecycle decisions when rolling back re-enrollment", async () => {
    const { root, home } = await makeFixture();
    const scenarios = [
      { action: "disabled", command: "disable", decision: "disabled" },
      { action: "ignored", command: "ignore", decision: "ignored" },
      { action: "inactive", command: "inactive", decision: "inactive" },
      { action: "removed", command: "remove", decision: "removed" },
    ] as const;
    for (const [index, scenario] of scenarios.entries()) {
      const repo = join(root, `repo-${scenario.command}`);
      await createRepository({ path: repo, home });
      const firstPlan = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      });
      const first = await applyProjectEnrollment({
        plan: firstPlan,
        expectedPlanSha256: firstPlan.planSha256,
        homeDir: home,
        now: new Date(`2026-07-28T1${index}:00:00.000Z`),
      });
      const configBefore = await readFile(
        join(repo, ".ai", "config.toml"),
        "utf8"
      );
      const ignoreBefore = await readFile(
        join(repo, ".ai", ".gitignore"),
        "utf8"
      );
      const secondPlan = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        cadence: "weekly",
        sources: ["git"],
      });
      const second = await applyProjectEnrollment({
        plan: secondPlan,
        expectedPlanSha256: secondPlan.planSha256,
        homeDir: home,
        now: new Date(`2026-07-29T1${index}:00:00.000Z`),
      });
      const previousLog = console.log;
      console.log = () => undefined;
      try {
        await projectCommand(
          [scenario.command, "--project-root", repo, "--json"],
          {
            homeDir: home,
            now: () => new Date(`2026-07-30T1${index}:00:00.000Z`),
          }
        );
      } finally {
        console.log = previousLog;
      }

      await rollbackProjectEnrollment({
        receiptId: second.receiptId,
        homeDir: home,
        apply: true,
        now: new Date(`2026-07-31T1${index}:00:00.000Z`),
      });

      const registry = (await Bun.file(second.registryPath).json()) as {
        projects: Record<
          string,
          {
            activeReceipts: Record<string, string>;
            cadence: string;
            decision: string;
            history: Array<{ action: string; receiptId?: string }>;
            sources: string[];
          }
        >;
      };
      const entry = registry.projects[firstPlan.identity.id];
      expect(entry?.decision).toBe(scenario.decision);
      expect(entry?.cadence).toBe("on-demand");
      expect(entry?.sources).toEqual(["git", "writebacks"]);
      expect(entry?.activeReceipts).toEqual({
        [repo]: first.receiptId,
      });
      expect(entry?.history.map((event) => event.action)).toEqual([
        "enrolled",
        "enrolled",
        scenario.action,
        "rolled-back",
      ]);
      expect(await readFile(join(repo, ".ai", "config.toml"), "utf8")).toBe(
        configBefore
      );
      expect(await readFile(join(repo, ".ai", ".gitignore"), "utf8")).toBe(
        ignoreBefore
      );
    }
  });

  it("does not preserve a canceled re-enrollment as a later lifecycle decision", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const first = await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      cadence: "weekly",
    });
    const second = await applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T13:00:00.000Z"),
    });

    await rollbackProjectEnrollment({
      receiptId: second.receiptId,
      homeDir: home,
      apply: true,
      now: new Date("2026-07-28T14:00:00.000Z"),
    });
    await rollbackProjectEnrollment({
      receiptId: first.receiptId,
      homeDir: home,
      apply: true,
      now: new Date("2026-07-28T15:00:00.000Z"),
    });

    const registry = (await Bun.file(first.registryPath).json()) as {
      projects: Record<
        string,
        {
          activeReceipts: Record<string, string>;
          decision: string;
          history: Array<{ action: string }>;
        }
      >;
    };
    expect(registry.projects[firstPlan.identity.id]).toMatchObject({
      activeReceipts: {},
      decision: "disabled",
    });
    expect(
      registry.projects[firstPlan.identity.id]?.history.map(
        (event) => event.action
      )
    ).toEqual(["enrolled", "enrolled", "rolled-back", "rolled-back"]);
    const status = await buildProjectsStatus({ homeDir: home });
    expect(status.projects[0]).toMatchObject({
      coverage: "inactive",
      decision: "disabled",
    });
  });

  it("preserves a lifecycle decision made before a canceled re-enrollment", async () => {
    const { root, home } = await makeFixture();
    const scenarios = [
      { command: "disable", decision: "disabled" },
      { command: "ignore", decision: "ignored" },
      { command: "inactive", decision: "inactive" },
      { command: "remove", decision: "removed" },
    ] as const;
    for (const [index, scenario] of scenarios.entries()) {
      const repo = join(root, `repo-${scenario.command}`);
      await createRepository({ path: repo, home });
      const firstPlan = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
      });
      const first = await applyProjectEnrollment({
        plan: firstPlan,
        expectedPlanSha256: firstPlan.planSha256,
        homeDir: home,
        now: new Date(`2026-07-28T1${index}:00:00.000Z`),
      });
      const previousLog = console.log;
      console.log = () => undefined;
      try {
        await projectCommand(
          [scenario.command, "--project-root", repo, "--json"],
          {
            homeDir: home,
            now: () => new Date(`2026-07-29T1${index}:00:00.000Z`),
          }
        );
      } finally {
        console.log = previousLog;
      }
      const secondPlan = await planProjectEnrollment({
        projectRoot: repo,
        homeDir: home,
        cadence: "weekly",
      });
      const second = await applyProjectEnrollment({
        plan: secondPlan,
        expectedPlanSha256: secondPlan.planSha256,
        homeDir: home,
        now: new Date(`2026-07-30T1${index}:00:00.000Z`),
      });

      await rollbackProjectEnrollment({
        receiptId: second.receiptId,
        homeDir: home,
        apply: true,
        now: new Date(`2026-07-31T1${index}:00:00.000Z`),
      });
      await rollbackProjectEnrollment({
        receiptId: first.receiptId,
        homeDir: home,
        apply: true,
        now: new Date(`2026-08-01T1${index}:00:00.000Z`),
      });

      const registry = (await Bun.file(first.registryPath).json()) as {
        projects: Record<
          string,
          {
            activeReceipts: Record<string, string>;
            decision: string;
          }
        >;
      };
      expect(registry.projects[firstPlan.identity.id]).toMatchObject({
        activeReceipts: {},
        decision: scenario.decision,
      });
    }
  }, 20_000);

  it("restores a later lifecycle decision when rollback compensation runs", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const firstPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    await applyProjectEnrollment({
      plan: firstPlan,
      expectedPlanSha256: firstPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    const secondPlan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const second = await applyProjectEnrollment({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      homeDir: home,
      now: new Date("2026-07-28T13:00:00.000Z"),
    });
    const previousLog = console.log;
    console.log = () => undefined;
    try {
      await projectCommand(["disable", "--project-root", repo, "--json"], {
        homeDir: home,
        now: () => new Date("2026-07-28T14:00:00.000Z"),
      });
    } finally {
      console.log = previousLog;
    }
    const registryBefore = await readFile(second.registryPath, "utf8");
    const configBefore = await readFile(
      join(repo, ".ai", "config.toml"),
      "utf8"
    );
    const ignoreBefore = await readFile(
      join(repo, ".ai", ".gitignore"),
      "utf8"
    );

    await expect(
      rollbackProjectEnrollment({
        receiptId: second.receiptId,
        homeDir: home,
        apply: true,
        beforeRegistryWrite: () =>
          Promise.reject(new Error("injected lifecycle rollback failure")),
      })
    ).rejects.toThrow("injected lifecycle rollback failure");

    expect(await readFile(second.registryPath, "utf8")).toBe(registryBefore);
    expect(await readFile(join(repo, ".ai", "config.toml"), "utf8")).toBe(
      configBefore
    );
    expect(await readFile(join(repo, ".ai", ".gitignore"), "utf8")).toBe(
      ignoreBefore
    );
    const registry = JSON.parse(registryBefore) as {
      projects: Record<
        string,
        {
          activeReceipts: Record<string, string>;
          decision: string;
        }
      >;
    };
    expect(registry.projects[firstPlan.identity.id]).toMatchObject({
      activeReceipts: { [repo]: second.receiptId },
      decision: "disabled",
    });
  });

  it("refuses rollback after the repository is replaced at the receipt path", async () => {
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
    });
    const configPath = join(repo, ".ai", "config.toml");
    const ignorePath = join(repo, ".ai", ".gitignore");
    const configBefore = await readFile(configPath, "utf8");
    const ignoreBefore = await readFile(ignorePath, "utf8");
    const registryBefore = await readFile(applied.registryPath, "utf8");

    await rm(join(repo, ".git"), { recursive: true });
    await runFixtureGit({
      argv: ["init", "-b", "main"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await writeFile(join(repo, "README.md"), "# Replacement\n", "utf8");
    await runFixtureGit({
      argv: ["add", "README.md"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await runFixtureGit({
      argv: [
        "-c",
        "user.name=Replacement",
        "-c",
        "user.email=replacement@example.test",
        "commit",
        "-m",
        "replacement",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });

    const replacementIdentity = await resolveRepositoryIdentity(repo, home);
    expect(replacementIdentity.id).not.toBe(plan.identity.id);
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(ignorePath, "utf8")).toBe(ignoreBefore);

    await expect(
      rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
        apply: true,
      })
    ).rejects.toThrow(
      "receipt project root no longer identifies the enrolled repository"
    );

    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(ignorePath, "utf8")).toBe(ignoreBefore);
    expect(await readFile(applied.registryPath, "utf8")).toBe(registryBefore);
  });

  it("fails closed when the canonical directory is swapped at the unlink boundary", async () => {
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
    });
    const aiRoot = join(repo, ".ai");
    const displacedAiRoot = join(repo, ".ai-enrolled");
    const configBefore = await readFile(join(aiRoot, "config.toml"), "utf8");
    const ignoreBefore = await readFile(join(aiRoot, ".gitignore"), "utf8");
    const registryBefore = await readFile(applied.registryPath, "utf8");
    let swapped = false;

    await expect(
      rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
        apply: true,
        beforeCanonicalRemove: async ({ path }) => {
          if (swapped || path !== join(aiRoot, "config.toml")) {
            return;
          }
          swapped = true;
          await rename(aiRoot, displacedAiRoot);
          await mkdir(aiRoot);
          await writeFile(
            join(aiRoot, "config.toml"),
            "replacement config\n",
            "utf8"
          );
          await writeFile(
            join(aiRoot, ".gitignore"),
            "replacement ignore\n",
            "utf8"
          );
        },
      })
    ).rejects.toThrow("canonical directory changed before unlink");

    expect(swapped).toBe(true);
    expect(await readFile(join(aiRoot, "config.toml"), "utf8")).toBe(
      "replacement config\n"
    );
    expect(await readFile(join(aiRoot, ".gitignore"), "utf8")).toBe(
      "replacement ignore\n"
    );
    expect(await readFile(join(displacedAiRoot, "config.toml"), "utf8")).toBe(
      configBefore
    );
    expect(await readFile(join(displacedAiRoot, ".gitignore"), "utf8")).toBe(
      ignoreBefore
    );
    expect(await readFile(applied.registryPath, "utf8")).toBe(registryBefore);
  });

  it("compensates a canonical leaf swap at the quarantine boundary", async () => {
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
    });
    const aiRoot = join(repo, ".ai");
    const configPath = join(aiRoot, "config.toml");
    const displacedConfigPath = join(aiRoot, "config.enrolled.toml");
    const configBefore = await readFile(configPath, "utf8");
    const ignoreBefore = await readFile(join(aiRoot, ".gitignore"), "utf8");
    const registryBefore = await readFile(applied.registryPath, "utf8");
    let swapped = false;

    await expect(
      rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
        apply: true,
        beforeCanonicalRemove: async ({ path }) => {
          if (swapped || path !== configPath) {
            return;
          }
          swapped = true;
          await rename(configPath, displacedConfigPath);
          await writeFile(configPath, "replacement config\n", "utf8");
        },
      })
    ).rejects.toThrow("target changed at quarantine boundary");

    expect(swapped).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe("replacement config\n");
    expect(await readFile(displacedConfigPath, "utf8")).toBe(configBefore);
    expect(await readFile(join(aiRoot, ".gitignore"), "utf8")).toBe(
      ignoreBefore
    );
    expect(
      (await readdir(aiRoot)).filter((name) => name.endsWith(".rollback"))
    ).toEqual([]);
    expect(await readFile(applied.registryPath, "utf8")).toBe(registryBefore);
  });

  it("compensates an existing canonical file swapped at the rollback exchange boundary", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({ path: repo, home });
    const aiRoot = join(repo, ".ai");
    const configPath = join(aiRoot, "config.toml");
    const enrolledPath = join(aiRoot, "config.enrolled.toml");
    const original = "version = 1\n\n[custom]\nowned = true\n";
    const concurrent = "version = 1\n\n[user]\nowned = true\n";
    await mkdir(aiRoot);
    await writeFile(configPath, original, "utf8");
    await writeFile(join(aiRoot, ".gitignore"), "/custom\n", "utf8");
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const applied = await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });
    const enrolled = await readFile(configPath, "utf8");
    const registryBefore = await readFile(applied.registryPath, "utf8");

    await expect(
      rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
        apply: true,
        beforeCanonicalRestore: async ({ path }) => {
          if (path !== configPath) {
            return;
          }
          await rename(configPath, enrolledPath);
          await writeFile(configPath, concurrent, "utf8");
        },
      })
    ).rejects.toThrow("conditional commit boundary");

    expect(await readFile(configPath, "utf8")).toBe(concurrent);
    expect(await readFile(enrolledPath, "utf8")).toBe(enrolled);
    expect(await readFile(applied.registryPath, "utf8")).toBe(registryBefore);
    expect(
      (await readdir(aiRoot)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  });

  it("restores canonical files and registry when rollback registry commit fails", async () => {
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
    });
    const configPath = join(repo, ".ai", "config.toml");
    const ignorePath = join(repo, ".ai", ".gitignore");
    const configBefore = await readFile(configPath, "utf8");
    const ignoreBefore = await readFile(ignorePath, "utf8");
    const registryBefore = await readFile(applied.registryPath, "utf8");

    await expect(
      rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
        apply: true,
        beforeRegistryWrite: () =>
          Promise.reject(new Error("injected rollback registry failure")),
      })
    ).rejects.toThrow("injected rollback registry failure");

    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(ignorePath, "utf8")).toBe(ignoreBefore);
    expect(await readFile(applied.registryPath, "utf8")).toBe(registryBefore);

    const retried = await rollbackProjectEnrollment({
      receiptId: applied.receiptId,
      homeDir: home,
      apply: true,
    });
    expect(retried.applied).toBe(true);
  });

  it("keeps the portfolio selected while another checkout remains enrolled", async () => {
    const { root, home } = await makeFixture();
    const activeRepo = join(root, "z-active");
    const rolledBackRepo = join(root, "a-rolled-back");
    await createRepository({ path: activeRepo, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/multi-checkout.git",
      ],
      repoDir: activeRepo,
      homeDir: home,
      cwd: activeRepo,
    });
    await runFixtureGit({
      argv: ["clone", activeRepo, rolledBackRepo],
      repoDir: rolledBackRepo,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/multi-checkout.git",
      ],
      repoDir: rolledBackRepo,
      homeDir: home,
      cwd: rolledBackRepo,
    });
    const activePlan = await planProjectEnrollment({
      projectRoot: activeRepo,
      homeDir: home,
    });
    const rolledBackPlan = await planProjectEnrollment({
      projectRoot: rolledBackRepo,
      homeDir: home,
    });
    const active = await applyProjectEnrollment({
      plan: activePlan,
      expectedPlanSha256: activePlan.planSha256,
      homeDir: home,
    });
    const rolledBack = await applyProjectEnrollment({
      plan: rolledBackPlan,
      expectedPlanSha256: rolledBackPlan.planSha256,
      homeDir: home,
    });

    await rollbackProjectEnrollment({
      receiptId: rolledBack.receiptId,
      homeDir: home,
      apply: true,
    });

    const registry = (await Bun.file(active.registryPath).json()) as {
      projects: Record<
        string,
        {
          activeReceipts: Record<string, string>;
          decision: string;
        }
      >;
    };
    const entry = registry.projects[activePlan.identity.id];
    expect(entry?.decision).toBe("selected");
    expect(entry?.activeReceipts).toEqual({
      [activeRepo]: active.receiptId,
    });
    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [activeRepo, rolledBackRepo],
    });
    expect(status.projects[0]).toMatchObject({
      decision: "selected",
      coverage: "covered",
      canonicalRoot: join(activeRepo, ".ai"),
    });
  });

  it("does not treat a stored same-path repository replacement as active", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const replacement = join(root, "replacement");
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
      argv: ["clone", repo, replacement],
      repoDir: replacement,
      homeDir: home,
      cwd: root,
    });
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/replacement-fork.git",
      ],
      repoDir: replacement,
      homeDir: home,
      cwd: replacement,
    });
    await rm(join(repo, ".git"), { recursive: true });
    await rename(join(replacement, ".git"), join(repo, ".git"));

    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects).toHaveLength(2);
    expect(
      status.projects.find(
        (project) => project.repositoryId === plan.identity.id
      )
    ).toMatchObject({
      repositoryId: plan.identity.id,
      decision: "selected",
      coverage: "partial",
      health: "unavailable",
      canonicalRoot: null,
      locations: [
        {
          path: repo,
          exists: false,
          dirty: null,
        },
      ],
    });
    expect(
      status.projects.find(
        (project) => project.repositoryId !== plan.identity.id
      )
    ).toMatchObject({
      decision: "inactive",
      coverage: "inactive",
    });
  });

  it("rejects a symlinked project registry from read-only discovery and status", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outsideRegistry = join(root, "outside-registry.json");
    await createRepository({ path: repo, home });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
    });
    const applied = await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });
    await rename(applied.registryPath, outsideRegistry);
    await symlink(outsideRegistry, applied.registryPath);

    await expect(buildProjectsStatus({ homeDir: home })).rejects.toThrow(
      "Refusing unsafe canonical file"
    );
    await expect(
      discoverProjects({ roots: [repo], homeDir: home })
    ).rejects.toThrow("Refusing unsafe canonical file");
  });

  it("propagates non-absence metadata failures for registered checkout paths", async () => {
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
    await rm(repo, { recursive: true });
    await symlink(repo, repo);

    await expect(buildProjectsStatus({ homeDir: home })).rejects.toMatchObject({
      code: "ELOOP",
    });
  });

  it("reports protective ignores ineffective after later negations", async () => {
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
    const ignorePath = join(repo, ".ai", ".gitignore");
    await writeFile(
      ignorePath,
      `${await readFile(ignorePath, "utf8")}!/*.toml   \n`,
      "utf8"
    );
    const gitCheck = await gitCheckIgnoreExitCode({
      path: ".ai/config.local.toml",
      repoDir: repo,
      homeDir: home,
    });
    expect(gitCheck).toBe(1);

    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "partial",
      health: "degraded",
      canonical: {
        protectiveIgnore: false,
      },
    });
  });

  it("requires protective ignore winners to come from project .ai/.gitignore", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const externalExcludes = join(root, "global-excludes");
    const ignorePath = join(repo, ".ai", ".gitignore");
    const externalRules = "/.ai/.facult/\n/.ai/config.local.toml\n";
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
    await writeFile(ignorePath, "", "utf8");
    await writeFile(externalExcludes, externalRules, "utf8");
    await runFixtureGit({
      argv: ["config", "core.excludesFile", externalExcludes],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    expect(
      await gitCheckIgnoreExitCode({
        path: ".ai/config.local.toml",
        repoDir: repo,
        homeDir: home,
      })
    ).toBe(0);
    let status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]?.canonical.protectiveIgnore).toBe(false);

    await runFixtureGit({
      argv: ["config", "--unset", "core.excludesFile"],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
    await writeFile(join(repo, ".git", "info", "exclude"), externalRules);
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]?.canonical.protectiveIgnore).toBe(false);

    await writeFile(ignorePath, "/.facult/\n/config.local.toml\n", "utf8");
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "covered",
      canonical: {
        protectiveIgnore: true,
      },
    });
  });

  it("uses Git directory-only ignore semantics for project health", async () => {
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
    await writeFile(
      join(repo, ".ai", ".gitignore"),
      "/.facult/\n/config*.toml\n",
      "utf8"
    );
    expect(
      await gitCheckIgnoreExitCode({
        path: ".ai/.facult/nested/probe",
        repoDir: repo,
        homeDir: home,
      })
    ).toBe(0);
    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]?.coverage).toBe("covered");
  });

  it("accepts equivalent wildcard protections with Git whitespace semantics", async () => {
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
    await writeFile(
      join(repo, ".ai", ".gitignore"),
      "/.facult/**   \n/config.local.*   \n",
      "utf8"
    );
    for (const pathValue of [
      ".ai/.facult/fclt-protective-probe",
      ".ai/.facult/nested/fclt-protective-probe",
      ".ai/config.local.toml",
    ]) {
      const gitCheck = await gitCheckIgnoreExitCode({
        path: pathValue,
        repoDir: repo,
        homeDir: home,
      });
      expect(gitCheck).toBe(0);
    }

    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "covered",
      canonical: {
        protectiveIgnore: true,
      },
    });
  });

  it("requires canonical config to be a readable regular non-symlink file", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const outsideConfig = join(root, "outside-config.toml");
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
    const configPath = join(repo, ".ai", "config.toml");
    await rename(configPath, outsideConfig);
    await symlink(outsideConfig, configPath);

    const status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]).toMatchObject({
      coverage: "partial",
      health: "degraded",
      canonical: {
        config: false,
      },
    });

    if (process.platform !== "win32") {
      await rm(configPath);
      await writeFile(configPath, await readFile(outsideConfig));
      await chmod(configPath, 0o000);
      try {
        const unreadableStatus = await buildProjectsStatus({
          homeDir: home,
          discoveryRoots: [repo],
        });
        expect(unreadableStatus.projects[0]?.canonical.config).toBe(false);
      } finally {
        await chmod(configPath, 0o600);
      }
    }
  });

  it("requires canonical config to match the bounded enrollment TOML schema", async () => {
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
    const configPath = join(repo, ".ai", "config.toml");
    const validConfig = await readFile(configPath, "utf8");
    const configIsHealthy = async () =>
      (
        await buildProjectsStatus({
          homeDir: home,
          discoveryRoots: [repo],
        })
      ).projects[0]?.canonical.config;

    for (const invalidConfig of [
      "not = [valid toml",
      validConfig.replace("version = 1", "version = 2"),
      validConfig.replace(
        `repository_id = "${plan.identity.id}"`,
        'repository_id = "repo_000000000000000000000000"'
      ),
      validConfig.replace('cadence = "on-demand"', 'cadence = "sometimes"'),
      validConfig.replace("guidance = []", 'guidance = ["../private.md"]'),
      validConfig.replace(
        "managed_rendering = false",
        "managed_rendering = true"
      ),
      validConfig.replace(
        "managed_rendering = false",
        "managed_rendering = false\nextra = true"
      ),
      `${validConfig}\n[project.extra]\nenabled = true\n`,
    ]) {
      await writeFile(configPath, invalidConfig, "utf8");
      expect(await configIsHealthy()).toBe(false);
    }

    await writeFile(configPath, validConfig, "utf8");
    expect(await configIsHealthy()).toBe(true);
    await truncate(configPath, 1024 * 1024 + 1);
    expect(await configIsHealthy()).toBe(false);
  });

  it("marks canonical config partial when enrollment options drift from the registry", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    await createRepository({
      path: repo,
      home,
      files: { "README.md": "# Project\n" },
    });
    const plan = await planProjectEnrollment({
      projectRoot: repo,
      homeDir: home,
      sources: ["git"],
      guidance: ["README.md"],
      cadence: "weekly",
    });
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir: home,
    });
    const configPath = join(repo, ".ai", "config.toml");
    const validConfig = await readFile(configPath, "utf8");
    const driftedConfigs = [
      validConfig.replace('sources = ["git", "guidance"]', 'sources = ["git"]'),
      validConfig.replace('guidance = ["README.md"]', "guidance = []"),
      validConfig.replace('cadence = "weekly"', 'cadence = "daily"'),
      validConfig.replace("scheduling = false", "scheduling = true"),
    ];

    for (const driftedConfig of driftedConfigs) {
      expect(driftedConfig).not.toBe(validConfig);
      await writeFile(configPath, driftedConfig, "utf8");
      const status = await buildProjectsStatus({
        homeDir: home,
        discoveryRoots: [repo],
      });
      expect(status.projects[0]).toMatchObject({
        coverage: "partial",
        health: "degraded",
        canonical: { config: false },
      });
    }

    await writeFile(configPath, validConfig, "utf8");
    const restored = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(restored.projects[0]).toMatchObject({
      coverage: "covered",
      canonical: { config: true },
    });
  });

  it("validates generated index and graph structure, bounds, and file safety", async () => {
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
    });
    const [indexPath, graphPath] = applied.generatedPaths;
    if (!(indexPath && graphPath)) {
      throw new Error("Expected generated project index and graph paths");
    }
    const indexContent = await readFile(indexPath, "utf8");
    const graphContent = await readFile(graphPath, "utf8");

    const malformedIndex = JSON.parse(indexContent) as {
      skills: Record<string, unknown>;
    };
    malformedIndex.skills = { broken: { name: "broken" } };
    await writeFile(
      indexPath,
      `${JSON.stringify(malformedIndex, null, 2)}\n`,
      "utf8"
    );
    let status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]).toMatchObject({
      health: "degraded",
      generated: { index: false, graph: true, health: "missing" },
    });

    await writeFile(indexPath, indexContent, "utf8");
    const malformedGraph = JSON.parse(graphContent) as {
      edges: unknown[];
    };
    malformedGraph.edges = [{}];
    await writeFile(
      graphPath,
      `${JSON.stringify(malformedGraph, null, 2)}\n`,
      "utf8"
    );
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]?.generated.graph).toBe(false);
    await writeFile(graphPath, graphContent, "utf8");

    const outsideGraph = join(root, "outside-graph.json");
    await rename(graphPath, outsideGraph);
    await symlink(outsideGraph, graphPath);
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]?.generated).toEqual({
      index: true,
      graph: false,
      health: "missing",
    });
    await rm(graphPath);
    await rename(outsideGraph, graphPath);

    if (process.platform !== "win32") {
      await chmod(indexPath, 0o000);
      try {
        status = await buildProjectsStatus({
          homeDir: home,
          discoveryRoots: [repo],
        });
        expect(status.projects[0]?.generated.index).toBe(false);
      } finally {
        await chmod(indexPath, 0o600);
      }
    }

    await truncate(indexPath, 64 * 1024 * 1024 + 1);
    status = await buildProjectsStatus({
      homeDir: home,
      discoveryRoots: [repo],
    });
    expect(status.projects[0]?.generated.index).toBe(false);
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

  it("rejects Windows lifecycle mutations before changing enrolled state", async () => {
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
    });
    const registryBefore = await readFile(applied.registryPath, "utf8");
    const configPath = join(repo, ".ai", "config.toml");
    const configBefore = await readFile(configPath, "utf8");
    const previousError = console.error;
    const previousExitCode = process.exitCode;
    console.error = () => undefined;
    try {
      process.exitCode = 0;
      await projectCommand(["disable", "--project-root", repo, "--json"], {
        homeDir: home,
        platform: "win32",
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode ?? 0;
      console.error = previousError;
    }
    expect(await readFile(applied.registryPath, "utf8")).toBe(registryBefore);
    expect(await readFile(configPath, "utf8")).toBe(configBefore);

    await expect(
      rollbackProjectEnrollment({
        receiptId: applied.receiptId,
        homeDir: home,
        apply: true,
        platform: "win32",
      })
    ).rejects.toThrow("registry mutation is unsupported on win32");
    expect(await readFile(applied.registryPath, "utf8")).toBe(registryBefore);
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
  });

  it("shares portfolio identity while isolating clone execution state", async () => {
    const { root, home } = await makeFixture();
    const repo = join(root, "repo");
    const clone = join(root, "clone");
    await createRepository({ path: repo, home });
    await runFixtureGit({
      argv: [
        "remote",
        "add",
        "origin",
        "https://github.com/example/portfolio-project.git",
      ],
      repoDir: repo,
      homeDir: home,
      cwd: repo,
    });
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
    await runFixtureGit({
      argv: [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/portfolio-project.git",
      ],
      repoDir: clone,
      homeDir: home,
      cwd: clone,
    });

    expect((await resolveRepositoryIdentity(clone)).id).toBe(plan.identity.id);
    expect(facultMachineStateDir(home, join(repo, ".ai"))).not.toBe(
      facultMachineStateDir(home, join(clone, ".ai"))
    );
  });
});
