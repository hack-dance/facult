import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { processStartIdentity } from "./process-identity";

test.skipIf(process.platform === "win32")(
  "uses a timezone-invariant Unix process start identity",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "fclt-process-identity-"));
    const executableDir = join(fixture, "bin");
    const psPath = join(executableDir, "ps");
    await mkdir(executableDir);
    await writeFile(
      psPath,
      `#!/bin/sh
case "$TZ" in
  UTC) printf '%s\\n' 'Wed Jul 29 16:00:00 2026' ;;
  America/Los_Angeles) printf '%s\\n' 'Wed Jul 29 09:00:00 2026' ;;
  Asia/Tokyo) printf '%s\\n' 'Thu Jul 30 01:00:00 2026' ;;
  *) printf '%s\\n' 'timezone was not fixed' ;;
esac
`,
      "utf8"
    );
    await chmod(psPath, 0o755);
    try {
      const identityFor = (timezone: string): string | undefined =>
        processStartIdentity(process.pid, {
          environment: {
            ...process.env,
            PATH: `${executableDir}${delimiter}${process.env.PATH ?? ""}`,
            TZ: timezone,
          },
        });

      const expected = `${process.platform}:Wed Jul 29 16:00:00 2026`;
      expect(identityFor("America/Los_Angeles")).toBe(expected);
      expect(identityFor("Asia/Tokyo")).toBe(expected);
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  }
);
