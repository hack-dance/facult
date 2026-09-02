#!/usr/bin/env bun

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const distDir = join(repoRoot, "dist");
const binaryBasePath = join(distDir, "fclt");
const compatibilityPath = join(distDir, "facult");
const packageJson = (await Bun.file(join(repoRoot, "package.json")).json()) as {
  version?: string;
};
const version = packageJson.version?.trim();

if (!version) {
  throw new Error("package.json is missing a version");
}

await mkdir(distDir, { recursive: true });

const build = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    "./src/index.ts",
    "--compile",
    "--define",
    `FCLT_COMPILED_VERSION=${JSON.stringify(version)}`,
    "--define",
    "FCLT_COMPILED_RUNTIME=true",
    "--outfile",
    binaryBasePath,
  ],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});

if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1);
}

const binaryPath = (await Bun.file(binaryBasePath).exists())
  ? binaryBasePath
  : `${binaryBasePath}.exe`;
const compatibilityBinaryPath = binaryPath.endsWith(".exe")
  ? `${compatibilityPath}.exe`
  : compatibilityPath;

await copyFile(binaryPath, compatibilityBinaryPath);
if (process.platform !== "win32") {
  await chmod(binaryPath, 0o755);
  await chmod(compatibilityBinaryPath, 0o755);
}

console.log(`Built ${binaryPath}`);
