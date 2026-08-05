import { packageVersion } from "./status";

export const FCLT_PLUGIN_PROTOCOL_VERSION = 1;
export const FCLT_PLUGIN_PROTOCOL_MIN = 1;
export const FCLT_PLUGIN_PROTOCOL_MAX = 1;

export interface FcltProtocolReport {
  schemaVersion: 1;
  packageVersion: string;
  protocol: {
    version: number;
    minimumPluginVersion: number;
    maximumPluginVersion: number;
  };
  runtime: {
    platform: NodeJS.Platform;
    architecture: string;
    executable: string;
  };
  capabilities: string[];
}

export async function protocolReport(): Promise<FcltProtocolReport> {
  return {
    schemaVersion: 1,
    packageVersion: await packageVersion(),
    protocol: {
      version: FCLT_PLUGIN_PROTOCOL_VERSION,
      minimumPluginVersion: FCLT_PLUGIN_PROTOCOL_MIN,
      maximumPluginVersion: FCLT_PLUGIN_PROTOCOL_MAX,
    },
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      executable: process.execPath,
    },
    capabilities: [
      "activity-action-decide-v1",
      "activity-action-resolve-v1",
      "audit-read-only-v1",
      "json-output-v1",
      "plugin-runtime-handshake-v1",
      "scoped-capability-roots-v1",
    ],
  };
}

export async function protocolCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt protocol — report the CLI/plugin compatibility contract

Usage:
  fclt protocol --json
`);
    return;
  }

  if (argv.some((arg) => arg !== "--json")) {
    console.error(
      `Unknown protocol option: ${argv.find((arg) => arg !== "--json")}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(await protocolReport(), null, 2));
}
