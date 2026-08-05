import { describe, expect, it } from "bun:test";
import {
  FCLT_PLUGIN_PROTOCOL_MAX,
  FCLT_PLUGIN_PROTOCOL_MIN,
  FCLT_PLUGIN_PROTOCOL_VERSION,
  protocolReport,
} from "./protocol";

const SEMVER_PREFIX_RE = /^\d+\.\d+\.\d+/;

describe("CLI/plugin protocol report", () => {
  it("reports a bounded explicit compatibility contract", async () => {
    const report = await protocolReport();

    expect(report.schemaVersion).toBe(1);
    expect(report.packageVersion).toMatch(SEMVER_PREFIX_RE);
    expect(report.protocol).toEqual({
      version: FCLT_PLUGIN_PROTOCOL_VERSION,
      minimumPluginVersion: FCLT_PLUGIN_PROTOCOL_MIN,
      maximumPluginVersion: FCLT_PLUGIN_PROTOCOL_MAX,
    });
    expect(report.protocol.minimumPluginVersion).toBeLessThanOrEqual(
      report.protocol.version
    );
    expect(report.protocol.maximumPluginVersion).toBeGreaterThanOrEqual(
      report.protocol.version
    );
    expect(report.runtime.platform).toBe(process.platform);
    expect(report.runtime.architecture).toBe(process.arch);
    expect(report.runtime.executable).toBe(process.execPath);
    expect(report.capabilities).toContain("plugin-runtime-handshake-v1");
    expect(report.capabilities).toContain("activity-action-decide-v1");
    expect(report.capabilities).toContain("activity-action-resolve-v1");
    expect(report.capabilities).toContain("audit-read-only-v1");
  });
});
