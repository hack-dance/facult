#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pkg = require("../package.json");

const REPO_OWNER = "hack-dance";
const REPO_NAME = "fclt";
const PACKAGE_NAME = "facult";
const DOWNLOAD_RETRIES = 12;
const DOWNLOAD_RETRY_DELAY_MS = 5000;
const ACTIVE_RUNTIME_WAIT_MS = 10_000;
const ACTIVE_RUNTIME_WAIT_INTERVAL_MS = 100;
const STALE_RUNTIME_TEMP_MS = 10 * 60 * 1000;
const NEWLINE_RE = /\r?\n/;
const SHA256_LINE_RE = /^([a-f0-9]{64})\s+(.+)$/i;

function isHelpLikeArgs(args) {
  return (
    args.length === 0 ||
    args.includes("--help") ||
    args.includes("-h") ||
    args[0] === "help"
  );
}

function localStateRoot(home) {
  const override = String(process.env.FACULT_LOCAL_STATE_DIR || "").trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "fclt");
  }
  const xdg = String(process.env.XDG_STATE_HOME || "").trim();
  return xdg
    ? path.join(path.resolve(xdg), "fclt")
    : path.join(home, ".local", "state", "fclt");
}

function localCacheRoot(home) {
  const override = String(process.env.FACULT_CACHE_DIR || "").trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === "darwin") {
    return path.join(localStateRoot(home), "cache");
  }
  const xdg = String(process.env.XDG_CACHE_HOME || "").trim();
  return xdg
    ? path.join(path.resolve(xdg), "fclt")
    : path.join(home, ".cache", "fclt");
}

async function main() {
  const resolved = resolveTarget();
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(1);
  }

  const version = String(pkg.version || "").trim();
  if (!version) {
    console.error("Invalid package version.");
    process.exit(1);
  }

  const home = os.homedir();
  const cacheRoot = await runtimeCacheRoot(home);
  const installDir = path.join(
    cacheRoot,
    version,
    `${resolved.platform}-${resolved.arch}`
  );
  const binaryName = resolved.platform === "windows" ? "fclt.exe" : "fclt";
  const binaryPath = path.join(installDir, binaryName);
  const sourceEntry = path.join(__dirname, "..", "src", "index.ts");
  const args = process.argv.slice(2);
  let installedBinaryThisRun = false;

  if (!(await fileExists(binaryPath))) {
    await removeStaleRuntimeTemps({
      installDir,
      binaryName,
      maxAgeMs: STALE_RUNTIME_TEMP_MS,
    });
    const packageManager = detectPackageManager();
    const hasSourceFallback = await canUseSourceFallback(sourceEntry);

    if (hasSourceFallback && isHelpLikeArgs(args)) {
      return runSourceFallback({
        sourceEntry,
        version,
        packageManager,
        reason: new Error("runtime binary missing for help-like command"),
      });
    }

    if (await hasIncompleteRuntimeCache({ installDir, binaryName })) {
      await waitForFile(binaryPath, {
        timeoutMs: ACTIVE_RUNTIME_WAIT_MS,
        intervalMs: ACTIVE_RUNTIME_WAIT_INTERVAL_MS,
      });
    }

    if (await fileExists(binaryPath)) {
      // Another concurrent launcher finished the runtime install while this
      // process was waiting.
    } else {
      const tag = `v${version}`;
      const assetName = `${PACKAGE_NAME}-${version}-${resolved.platform}-${resolved.arch}${resolved.ext}`;
      const url = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/${assetName}`;
      const checksumsUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/SHA256SUMS`;
      const tmpPath = `${binaryPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const checksumsPath = `${tmpPath}.sha256sums`;

      try {
        await fsp.mkdir(installDir, { recursive: true });
        await downloadWithRetry(url, tmpPath, {
          attempts: DOWNLOAD_RETRIES,
          delayMs: DOWNLOAD_RETRY_DELAY_MS,
        });
        await downloadWithRetry(checksumsUrl, checksumsPath, {
          attempts: DOWNLOAD_RETRIES,
          delayMs: DOWNLOAD_RETRY_DELAY_MS,
        });
        await verifyDownloadedRuntime({
          assetName,
          checksumsPath,
          runtimePath: tmpPath,
        });
        if (resolved.platform !== "windows") {
          await fsp.chmod(tmpPath, 0o755);
        }
        await installDownloadedRuntime(tmpPath, binaryPath);
        installedBinaryThisRun = true;
      } catch (error) {
        await safeUnlink(tmpPath);
        if (await canUseSourceFallback(sourceEntry)) {
          return runSourceFallback({
            sourceEntry,
            version,
            packageManager: detectPackageManager(),
            reason: error,
          });
        }
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        console.error(
          [
            "Unable to download the fclt binary for this platform.",
            `Expected asset: ${assetName}`,
            `URL: ${url}`,
            `Reason: ${message}`,
            "",
            "Try installing directly from releases:",
            "https://github.com/hack-dance/fclt/releases",
          ].join("\n")
        );
        process.exit(1);
      } finally {
        await safeUnlink(checksumsPath);
      }
    }
  }

  const packageManager = detectPackageManager();
  if (installedBinaryThisRun) {
    await bestEffortWriteInstallState({
      method: "npm-binary-cache",
      version,
      binaryPath,
      packageManager,
    });
  }

  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      FACULT_INSTALL_METHOD: "npm-binary-cache",
      FACULT_NPM_PACKAGE_VERSION: version,
      FACULT_RUNTIME_BINARY: binaryPath,
      FACULT_INSTALL_PM: packageManager,
    },
  });

  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  process.exit(1);
}

async function runtimeCacheRoot(home) {
  const primary = path.join(localCacheRoot(home), "runtime");
  try {
    await fsp.mkdir(primary, { recursive: true });
    return primary;
  } catch {
    const fallback = path.join(os.tmpdir(), "fclt", "runtime-cache");
    try {
      await fsp.mkdir(fallback, { recursive: true });
      return fallback;
    } catch {
      return primary;
    }
  }
}

async function canUseSourceFallback(sourceEntry) {
  if (!(await fileExists(sourceEntry))) {
    return false;
  }
  const result = spawnSync("bun", ["--version"], {
    stdio: "ignore",
    env: process.env,
  });
  return result.status === 0;
}

function runSourceFallback({ sourceEntry, version, packageManager, reason }) {
  const message =
    reason instanceof Error ? reason.message : String(reason ?? "");
  console.error(
    `fclt: cached runtime unavailable, falling back to Bun source entry (${message})`
  );
  const args = process.argv.slice(2);
  const result = spawnSync("bun", [sourceEntry, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      FACULT_INSTALL_METHOD: "npm-source-fallback",
      FACULT_NPM_PACKAGE_VERSION: version,
      FACULT_SOURCE_ENTRY: sourceEntry,
      FACULT_INSTALL_PM: packageManager,
    },
  });

  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  process.exit(1);
}

function resolveTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") {
    return { ok: true, platform: "darwin", arch: "arm64", ext: "" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { ok: true, platform: "darwin", arch: "x64", ext: "" };
  }
  if (platform === "linux" && arch === "x64") {
    return { ok: true, platform: "linux", arch: "x64", ext: "" };
  }
  if (platform === "win32" && arch === "x64") {
    return { ok: true, platform: "windows", arch: "x64", ext: ".exe" };
  }
  return {
    ok: false,
    message: [
      `Unsupported platform/arch: ${platform}/${arch}`,
      "Prebuilt binaries are currently available for:",
      "  - darwin/x64",
      "  - darwin/arm64",
      "  - linux/x64",
      "  - windows/x64",
    ].join("\n"),
  };
}

function detectPackageManager() {
  const forced = String(process.env.FACULT_INSTALL_PM || "").trim();
  if (forced === "bun" || forced === "npm") {
    return forced;
  }

  const userAgent = String(process.env.npm_config_user_agent || "");
  if (userAgent.startsWith("bun/")) {
    return "bun";
  }
  if (userAgent.startsWith("npm/")) {
    return "npm";
  }
  if (__filename.includes(`${path.sep}.bun${path.sep}`)) {
    return "bun";
  }
  return "npm";
}

function buildRequestHeaders() {
  return {
    "user-agent": "fclt-installer",
    accept: "application/octet-stream",
  };
}

async function download(url, destinationPath) {
  await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: buildRequestHeaders(),
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          download(response.headers.location, destinationPath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `HTTP ${response.statusCode ?? "unknown"} while downloading`
            )
          );
          return;
        }

        const file = fs.createWriteStream(destinationPath);
        response.pipe(file);
        file.on("finish", () => {
          file.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(undefined);
          });
        });
        file.on("error", (err) => reject(err));
      }
    );

    request.on("error", (err) => reject(err));
  });
}

async function downloadWithRetry(url, destinationPath, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await safeUnlink(destinationPath);
      await download(url, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts) {
        break;
      }
      await sleep(options.delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function expectedChecksum(checksumsText, assetName) {
  const matches = [];
  for (const rawLine of checksumsText.split(NEWLINE_RE)) {
    const match = SHA256_LINE_RE.exec(rawLine.trim());
    if (match && match[2] === assetName) {
      matches.push(match[1].toLowerCase());
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `SHA256SUMS must contain exactly one digest for ${assetName}`
    );
  }
  return matches[0];
}

async function sha256File(filePath) {
  const hasher = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

async function verifyDownloadedRuntime({
  assetName,
  checksumsPath,
  runtimePath,
}) {
  const checksumsText = await fsp.readFile(checksumsPath, "utf8");
  const expected = expectedChecksum(checksumsText, assetName);
  const actual = await sha256File(runtimePath);
  if (actual !== expected) {
    throw new Error(`Checksum verification failed for ${assetName}`);
  }
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasIncompleteRuntimeCache({ installDir, binaryName }) {
  try {
    const entries = await fsp.readdir(installDir);
    return entries.some((entry) => entry.startsWith(`${binaryName}.tmp-`));
  } catch {
    return false;
  }
}

async function removeStaleRuntimeTemps({ installDir, binaryName, maxAgeMs }) {
  try {
    const entries = await fsp.readdir(installDir);
    const now = Date.now();
    const stalePaths = [];
    for (const entry of entries) {
      if (!entry.startsWith(`${binaryName}.tmp-`)) {
        continue;
      }
      const candidate = path.join(installDir, entry);
      try {
        const stats = await fsp.stat(candidate);
        if (now - stats.mtimeMs > maxAgeMs) {
          stalePaths.push(candidate);
        }
      } catch {
        // Ignore temp files that disappeared while scanning.
      }
    }
    await Promise.all(stalePaths.map((candidate) => safeUnlink(candidate)));
  } catch {
    // Ignore missing runtime dirs while cleaning stale temp files.
  }
}

async function waitForFile(filePath, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(filePath)) {
      return true;
    }
    await sleep(intervalMs);
  }
  return await fileExists(filePath);
}

async function installDownloadedRuntime(tmpPath, binaryPath) {
  if (await fileExists(binaryPath)) {
    await safeUnlink(tmpPath);
    return;
  }
  try {
    await fsp.rename(tmpPath, binaryPath);
  } catch (error) {
    if (await fileExists(binaryPath)) {
      await safeUnlink(tmpPath);
      return;
    }
    throw error;
  }
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore missing temp files during retries and cleanup.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeInstallState(state) {
  const home = os.homedir();
  const installStateDir = localStateRoot(home);
  const installStatePath = path.join(installStateDir, "install.json");
  await fsp.mkdir(installStateDir, { recursive: true });
  await fsp.writeFile(
    `${installStatePath}.tmp`,
    JSON.stringify(state, null, 2)
  );
  await fsp.rename(`${installStatePath}.tmp`, installStatePath);
}

async function bestEffortWriteInstallState(state) {
  try {
    await writeInstallState(state);
  } catch {
    // Install state is useful metadata, but it should not block normal CLI usage.
  }
}

module.exports = { expectedChecksum, sha256File, verifyDownloadedRuntime };

if (require.main === module) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    console.error(message);
    process.exit(1);
  });
}
