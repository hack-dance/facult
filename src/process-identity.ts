import { spawnSync } from "node:child_process";

export function processStartIdentity(
  pid: number,
  options: { environment?: NodeJS.ProcessEnv } = {}
): string | undefined {
  const environment = options.environment ?? process.env;
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { encoding: "utf8", env: environment }
        )
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          env: {
            ...environment,
            LC_ALL: "C",
            TZ: "UTC",
          },
        });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const startedAt = result.stdout.trim();
  return startedAt ? `${process.platform}:${startedAt}` : undefined;
}
