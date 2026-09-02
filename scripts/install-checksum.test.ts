import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const installScript = join(repoRoot, "scripts", "install.sh");

function releasePlatform(): { arch: string; os: string } {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return { arch, os };
}

async function runInstaller(args: { validChecksum: boolean }): Promise<{
  code: number;
  installDir: string;
  stderr: string;
  stdout: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "fclt-install-checksum-"));
  const home = join(root, "home");
  const installDir = join(root, "install");
  const mockBin = join(root, "mock-bin");
  const binaryFixture = join(root, "binary-fixture");
  const checksumFixture = join(root, "SHA256SUMS");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(installDir, { recursive: true }),
    mkdir(mockBin, { recursive: true }),
  ]);
  const version = "9.8.7";
  const platform = releasePlatform();
  const assetName = `fclt-${version}-${platform.os}-${platform.arch}`;
  const binary = "#!/usr/bin/env bash\nprintf 'fixture binary\\n'\n";
  const digest = createHash("sha256").update(binary).digest("hex");
  await Bun.write(binaryFixture, binary);
  await Bun.write(
    checksumFixture,
    `${args.validChecksum ? digest : "0".repeat(64)}  ${assetName}\n`
  );
  const curlPath = join(mockBin, "curl");
  await Bun.write(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [[ "$url" != https://github.com/hack-dance/fclt/* ]]; then
  exit 22
fi
if [[ "$url" == */SHA256SUMS ]]; then
  cp "$FCLT_TEST_CHECKSUMS" "$output"
else
  cp "$FCLT_TEST_BINARY" "$output"
fi
`
  );
  await chmod(curlPath, 0o755);
  const proc = Bun.spawn(["bash", installScript], {
    cwd: root,
    env: {
      ...process.env,
      FACULT_DOWNLOAD_RETRIES: "1",
      FACULT_INSTALL_DIR: installDir,
      FACULT_VERSION: version,
      FCLT_TEST_BINARY: binaryFixture,
      FCLT_TEST_CHECKSUMS: checksumFixture,
      HOME: home,
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { code, installDir, stderr, stdout };
}

describe("release installer checksum verification", () => {
  it("installs only after the selected release asset matches SHA256SUMS", async () => {
    const result = await runInstaller({ validChecksum: true });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified fclt-9.8.7-");
    expect(await Bun.file(join(result.installDir, "fclt")).exists()).toBe(true);
    expect(await Bun.file(join(result.installDir, "facult")).exists()).toBe(
      true
    );
  });

  it("rejects a mismatched release asset before installation", async () => {
    const result = await runInstaller({ validChecksum: false });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Checksum verification failed");
    expect(await Bun.file(join(result.installDir, "fclt")).exists()).toBe(
      false
    );
  });
});
