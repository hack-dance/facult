import { expect, it } from "bun:test";
import { parse as parseYaml } from "yaml";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

it("publishes checksummed SBOM-bearing release assets with build provenance", async () => {
  const workflowText = await Bun.file(
    new URL("../.github/workflows/release.yml", import.meta.url)
  ).text();
  const workflow: unknown = parseYaml(workflowText);
  expect(isPlainObject(workflow)).toBe(true);
  if (!(isPlainObject(workflow) && isPlainObject(workflow.jobs))) {
    throw new Error("Release workflow jobs are missing.");
  }
  const publishAssets = workflow.jobs["publish-assets"];
  if (!isPlainObject(publishAssets)) {
    throw new Error("Release publish-assets job is missing.");
  }
  expect(publishAssets["runs-on"]).toBe("ubuntu-latest");
  expect(publishAssets.permissions).toEqual({
    attestations: "write",
    contents: "write",
    "id-token": "write",
  });
  if (!Array.isArray(publishAssets.steps)) {
    throw new Error("Release publish-assets steps are missing.");
  }
  const steps = publishAssets.steps.filter(isPlainObject);
  const sbomIndex = steps.findIndex(
    (step) => step.uses === "anchore/sbom-action@v0"
  );
  const checksumIndex = steps.findIndex(
    (step) => step.name === "Generate release checksums"
  );
  const attestationIndex = steps.findIndex(
    (step) => step.uses === "actions/attest-build-provenance@v3"
  );
  const uploadIndex = steps.findIndex(
    (step) => step.uses === "softprops/action-gh-release@v2"
  );
  expect(sbomIndex).toBeGreaterThan(-1);
  expect(checksumIndex).toBeGreaterThan(sbomIndex);
  expect(attestationIndex).toBeGreaterThan(checksumIndex);
  expect(uploadIndex).toBeGreaterThan(attestationIndex);

  const sbom = steps[sbomIndex];
  const attestation = steps[attestationIndex];
  expect(isPlainObject(sbom?.with) ? sbom.with.format : undefined).toBe(
    "spdx-json"
  );
  expect(
    isPlainObject(attestation?.with)
      ? String(attestation.with["subject-path"])
      : ""
  ).toContain("SHA256SUMS");
});
