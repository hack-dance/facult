import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { facultInstallStatePath, facultRuntimeCacheDir } from "../src/paths";

const version = (await import("../package.json")).version as string;
const platform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
const arch = process.arch;
const repoRoot = resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const launcherChecksum = require("./fclt.cjs") as {
  expectedChecksum: (text: string, assetName: string) => string;
  verifyDownloadedRuntime: (args: {
    assetName: string;
    checksumsPath: string;
    runtimePath: string;
  }) => Promise<void>;
};

const tempDirs: string[] = [];
const localOnly = process.env.FACULT_TEST_SKIP_LOCAL === "1";

it("verifies downloaded npm-launcher runtimes against one exact checksum entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-launcher-checksum-"));
  tempDirs.push(root);
  const runtimePath = join(root, "facult-runtime");
  const checksumsPath = join(root, "SHA256SUMS");
  const assetName = "facult-9.8.7-darwin-arm64";
  const runtime = "compiled runtime fixture\n";
  const digest = createHash("sha256").update(runtime).digest("hex");
  await writeFile(runtimePath, runtime, "utf8");
  await writeFile(checksumsPath, `${digest}  ${assetName}\n`, "utf8");

  await expect(
    launcherChecksum.verifyDownloadedRuntime({
      assetName,
      checksumsPath,
      runtimePath,
    })
  ).resolves.toBeUndefined();
  expect(() =>
    launcherChecksum.expectedChecksum(`${digest}  other-asset\n`, assetName)
  ).toThrow("exactly one digest");

  await writeFile(checksumsPath, `${"0".repeat(64)}  ${assetName}\n`, "utf8");
  await expect(
    launcherChecksum.verifyDownloadedRuntime({
      assetName,
      checksumsPath,
      runtimePath,
    })
  ).rejects.toThrow("Checksum verification failed");
});

async function resolveLauncherRuntime(): Promise<string> {
  try {
    await access(process.execPath);
    return process.execPath;
  } catch {
    // Fall back to shell lookup if the current runtime path is unavailable.
  }

  if (process.platform === "win32") {
    return process.execPath;
  }

  const proc = Bun.spawn({
    cmd: ["/bin/sh", "-lc", "command -v bun || command -v node"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode === 0) {
    const runtime = stdout.trim();
    if (runtime) {
      return runtime;
    }
  }

  return process.execPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    })
  );
});

it("does not write install metadata when using a cached runtime binary", async () => {
  if (localOnly) {
    return;
  }

  const homeDir = await mkdtemp(join(tmpdir(), "fclt-launcher-"));
  tempDirs.push(homeDir);

  const runtimeDir = join(
    facultRuntimeCacheDir(homeDir),
    version,
    `${platform}-${arch}`
  );
  await mkdir(runtimeDir, { recursive: true });

  const binaryName = process.platform === "win32" ? "fclt.exe" : "fclt";
  const binaryPath = join(runtimeDir, binaryName);
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(binaryPath, 0o755);
  const launcherRuntime = await resolveLauncherRuntime();

  const proc = Bun.spawn({
    cmd: [launcherRuntime, "bin/fclt.cjs", "help"],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");

  const installStatePath = facultInstallStatePath(homeDir);
  await expect(stat(installStatePath)).rejects.toThrow();
});

it("uses a temp runtime cache when the configured cache root is unavailable", async () => {
  if (localOnly) {
    return;
  }

  const homeDir = await mkdtemp(join(tmpdir(), "fclt-launcher-"));
  const tmpHome = await mkdtemp(join(tmpdir(), "fclt-launcher-tmp-"));
  tempDirs.push(homeDir, tmpHome);

  const badCacheRoot = join(homeDir, "not-a-directory");
  await writeFile(badCacheRoot, "file", "utf8");

  const runtimeDir = join(
    tmpHome,
    "fclt",
    "runtime-cache",
    version,
    `${platform}-${arch}`
  );
  await mkdir(runtimeDir, { recursive: true });

  const binaryName = process.platform === "win32" ? "fclt.exe" : "fclt";
  const binaryPath = join(runtimeDir, binaryName);
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(binaryPath, 0o755);
  const launcherRuntime = await resolveLauncherRuntime();

  const proc = Bun.spawn({
    cmd: [launcherRuntime, "bin/fclt.cjs", "help"],
    cwd: repoRoot,
    env: {
      ...process.env,
      FACULT_CACHE_DIR: badCacheRoot,
      HOME: homeDir,
      TMPDIR: tmpHome,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
});

it("falls back quickly to the bundled source entry when the cached runtime is incomplete", async () => {
  if (localOnly) {
    return;
  }

  const homeDir = await mkdtemp(join(tmpdir(), "fclt-launcher-fallback-"));
  tempDirs.push(homeDir);

  const runtimeDir = join(
    facultRuntimeCacheDir(homeDir),
    version,
    `${platform}-${arch}`
  );
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, `fclt.tmp-${Date.now()}`),
    "partial",
    "utf8"
  );
  const launcherRuntime = await resolveLauncherRuntime();

  const proc = Bun.spawn({
    cmd: [launcherRuntime, "bin/fclt.cjs", "--help"],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      HTTPS_PROXY: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(-999), 1500)),
  ]);

  if (exitCode === -999) {
    proc.kill();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("fclt");
  expect(stdout).toContain("Manage canonical AI capability");
  expect(stderr).not.toContain("Unable to download the fclt binary");
});

it("waits for a concurrent launcher to finish writing the runtime binary", async () => {
  if (localOnly) {
    return;
  }

  const homeDir = await mkdtemp(join(tmpdir(), "fclt-launcher-wait-"));
  tempDirs.push(homeDir);

  const runtimeDir = join(
    facultRuntimeCacheDir(homeDir),
    version,
    `${platform}-${arch}`
  );
  await mkdir(runtimeDir, { recursive: true });

  const binaryName = process.platform === "win32" ? "fclt.exe" : "fclt";
  const binaryPath = join(runtimeDir, binaryName);
  const tempPath = join(runtimeDir, `${binaryName}.tmp-active`);
  await writeFile(tempPath, "partial", "utf8");

  const writerDone = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      writeFile(binaryPath, "#!/bin/sh\necho cached-runtime-ready\n", "utf8")
        .then(() => chmod(binaryPath, 0o755))
        .then(() => rm(tempPath, { force: true }))
        .then(resolve, reject);
    }, 150);
  });

  const launcherRuntime = await resolveLauncherRuntime();
  const proc = Bun.spawn({
    cmd: [launcherRuntime, "bin/fclt.cjs", "--version"],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      HTTPS_PROXY: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  await writerDone;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("cached-runtime-ready");
  expect(stderr).toBe("");
});
