import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCliContextArgs,
  resolveCliContextRoot,
  resolveCliContextScope,
} from "./cli-context";

let tempRoot: string | null = null;
const ORIGINAL_ROOT = process.env.FACULT_ROOT_DIR;
const ORIGINAL_ROOT_SCOPE = process.env.FACULT_ROOT_SCOPE;

function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cli-context-"));
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = null;
  process.env.FACULT_ROOT_DIR = ORIGINAL_ROOT;
  process.env.FACULT_ROOT_SCOPE = ORIGINAL_ROOT_SCOPE;
});

describe("parseCliContextArgs", () => {
  it("parses scope, source, and root flags", () => {
    const parsed = parseCliContextArgs(
      ["skills", "--scope", "project", "--source=project", "--root", "~/repo"],
      { allowSource: true }
    );

    expect(parsed).toEqual({
      argv: ["skills"],
      rootArg: "~/repo",
      scope: "project",
      sourceKind: "project",
    });
  });

  it("rejects conflicting scope flags", () => {
    expect(() =>
      parseCliContextArgs(["--global", "--scope", "project"])
    ).toThrow("Conflicting scope flags");
  });
});

describe("resolveCliContextScope", () => {
  it("preserves explicit scope for custom .ai roots", () => {
    const homeDir = "/tmp/home";
    const rootDir = "/tmp/shared/.ai";
    expect(resolveCliContextScope({ homeDir, rootDir, scope: "global" })).toBe(
      "global"
    );
    expect(resolveCliContextScope({ homeDir, rootDir, scope: "project" })).toBe(
      "project"
    );
    expect(resolveCliContextScope({ homeDir, rootDir, scope: "merged" })).toBe(
      "project"
    );
  });
});

describe("resolveCliContextRoot", () => {
  it("resolves explicit home-relative and cwd-relative root arguments", () => {
    const homeDir = "/tmp/home";
    const cwd = "/tmp/home/work/repo";
    expect(
      resolveCliContextRoot({
        homeDir,
        cwd,
        rootArg: "~/shared/.ai",
        scope: "global",
      })
    ).toBe("/tmp/home/shared/.ai");
    expect(
      resolveCliContextRoot({
        homeDir,
        cwd,
        rootArg: "local/.ai",
        scope: "global",
      })
    ).toBe("/tmp/home/work/repo/local/.ai");
  });

  it("prefers the nearest project .ai root for merged scope", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const cwd = join(homeDir, "work", "repo", "src");
    await mkdir(join(homeDir, "work", "repo", ".ai", "instructions"), {
      recursive: true,
    });
    const rootDir = resolveCliContextRoot({ homeDir, cwd, scope: "merged" });
    expect(rootDir).toBe(join(homeDir, "work", "repo", ".ai"));
  });

  it("accepts a lightweight project .ai root that only has config.toml", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const projectRoot = join(homeDir, "work", "repo");
    const cwd = join(projectRoot, "src");
    await mkdir(join(projectRoot, ".ai"), { recursive: true });
    await Bun.write(join(projectRoot, ".ai", "config.toml"), "version = 1\n");

    const rootDir = resolveCliContextRoot({ homeDir, cwd, scope: "project" });
    expect(rootDir).toBe(join(projectRoot, ".ai"));
  });

  it("resolves global scope to the global canonical root", () => {
    const homeDir = "/tmp/home";
    const cwd = "/tmp/home/work/repo";
    const rootDir = resolveCliContextRoot({ homeDir, cwd, scope: "global" });
    expect(rootDir).toBe("/tmp/home/.ai");
  });

  it("honors FACULT_ROOT_DIR before cwd project discovery in merged scope", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const envRoot = join(tempRoot, "external-root");
    const cwd = join(homeDir, "work", "repo", "src");
    await mkdir(join(envRoot, "instructions"), { recursive: true });
    await mkdir(join(homeDir, "work", "repo", ".ai", "instructions"), {
      recursive: true,
    });
    process.env.FACULT_ROOT_DIR = envRoot;

    const rootDir = resolveCliContextRoot({ homeDir, cwd, scope: "merged" });
    expect(rootDir).toBe(envRoot);
  });

  it("explains how to create project AI state when project scope has no repo-local .ai", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const cwd = join(homeDir, "work", "repo");
    await mkdir(cwd, { recursive: true });

    expect(() =>
      resolveCliContextRoot({ homeDir, cwd, scope: "project" })
    ).toThrow("No project-local .ai root found:");
    expect(() =>
      resolveCliContextRoot({ homeDir, cwd, scope: "project" })
    ).toThrow('Run "fclt project init" to preview minimal enrollment');
  });

  it("does not treat the global home .ai root as project state", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const cwd = join(homeDir, "work", "repo");
    await mkdir(join(homeDir, ".ai", "instructions"), { recursive: true });
    await mkdir(cwd, { recursive: true });

    expect(() =>
      resolveCliContextRoot({ homeDir, cwd, scope: "project" })
    ).toThrow("No project-local .ai root found:");
    expect(resolveCliContextRoot({ homeDir, cwd, scope: "merged" })).toBe(
      join(homeDir, ".ai")
    );
  });

  it("does not treat home .ai as project state with a custom global root", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const cwd = join(homeDir, "work", "repo");
    const globalRoot = join(tempRoot, "global-ai");
    await mkdir(join(homeDir, ".ai", "instructions"), { recursive: true });
    await mkdir(join(globalRoot, "instructions"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    process.env.FACULT_ROOT_DIR = globalRoot;

    expect(() =>
      resolveCliContextRoot({ homeDir, cwd, scope: "project" })
    ).toThrow("No project-local .ai root found:");
    expect(resolveCliContextRoot({ homeDir, cwd, scope: "merged" })).toBe(
      globalRoot
    );
  });

  it("prefers an env-configured project .ai root over cwd discovery", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const projectRoot = join(homeDir, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const cwd = join(homeDir, "work", "other-repo");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(cwd, ".ai", "instructions"), { recursive: true });
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_ROOT_SCOPE = "project";

    expect(resolveCliContextRoot({ homeDir, cwd, scope: "project" })).toBe(
      rootDir
    );
    expect(resolveCliContextRoot({ homeDir, cwd, scope: "global" })).toBe(
      join(homeDir, ".ai")
    );
  });

  it("treats an unscoped env .ai override as global", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const globalRoot = join(tempRoot, "workspace", ".ai");
    const cwd = join(tempRoot, "workspace", "repo");
    await mkdir(join(globalRoot, "instructions"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    process.env.FACULT_ROOT_DIR = globalRoot;

    expect(() =>
      resolveCliContextRoot({ homeDir, cwd, scope: "project" })
    ).toThrow("No project-local .ai root found:");
    expect(resolveCliContextRoot({ homeDir, cwd, scope: "merged" })).toBe(
      globalRoot
    );
  });
});
