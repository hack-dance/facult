import { afterEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { renderCanonicalText } from "./agents";
import { facultAiIndexPath, facultLocalStateRoot } from "./paths";
import {
  checkRemoteUpdates,
  installRemoteItem,
  quoteAutomationShellArg,
  scaffoldBuiltinOperatingModelPack,
  scaffoldCodexAutomationTemplate,
  searchRemoteItems,
  setCodexAutomationStatus,
  sourcesCommand,
  templatesCommand,
  verifySourceCommand,
} from "./remote";
import { renderSnippetText } from "./snippets";

const BLOCKED_BY_POLICY_RE = /blocked by policy/i;
const INTEGRITY_CHECK_FAILED_RE = /integrity check failed/i;
const MULTIPLE_SIGNATURE_KEYS_RE = /multiple configured keys/i;
const REQUIRES_REVIEW_RE = /requires review/i;
const REVOKED_SIGNATURE_KEY_RE = /is revoked/i;
const SIGNATURE_CHECK_FAILED_RE = /signature check failed/i;

it("quotes automation roots for POSIX shells and Windows PowerShell", () => {
  expect(
    quoteAutomationShellArg("/tmp/shared $() `tick` 'quote", "darwin")
  ).toBe("'/tmp/shared $() `tick` '\"'\"'quote'");
  expect(
    quoteAutomationShellArg("C:\\Shared Folder\\team's .ai", "win32")
  ).toBe("'C:\\Shared Folder\\team''s .ai'");
});

let tempDir: string | null = null;
const originalCwd = process.cwd();

function sha256Hex(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

async function makeTempRoot(): Promise<{ home: string; root: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "facult-remote-")));
  tempDir = dir;
  const home = join(dir, "home");
  const root = join(home, "agents", ".facult");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  return { home, root };
}

async function initializeGitRepository(
  repoDir: string,
  home: string
): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await runFixtureGit({
    argv: ["init", "-b", "main", repoDir],
    repoDir,
    homeDir: home,
  });
  await writeFile(join(repoDir, "README.md"), "# Fixture\n");
  await runFixtureGit({
    argv: ["add", "."],
    repoDir,
    homeDir: home,
    cwd: repoDir,
  });
  await runFixtureGit({
    argv: [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    ],
    repoDir,
    homeDir: home,
    cwd: repoDir,
  });
}

async function withMutedConsole(fn: () => Promise<void>) {
  const prevLog = console.log;
  const prevError = console.error;
  console.log = () => {
    // mute logs during CLI command tests
  };
  console.error = () => {
    // mute errors during CLI command tests
  };
  try {
    await fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
}

async function withCapturedConsole(
  fn: () => Promise<void>
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const prevLog = console.log;
  const prevError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((v) => String(v)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((v) => String(v)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
  return { logs, errors };
}

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = 0;
  if (!tempDir) {
    return;
  }
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("remote search/install/update", () => {
  it("searches builtin index and returns template results", async () => {
    const { home } = await makeTempRoot();
    const rows = await searchRemoteItems({
      query: "template",
      homeDir: home,
      cwd: home,
    });
    expect(
      rows.some((r) => r.index === "facult" && r.item.id === "skill-template")
    ).toBe(true);
    expect(
      rows.some(
        (r) => r.index === "facult" && r.item.id === "mcp-stdio-template"
      )
    ).toBe(true);
  });

  it("installs builtin skill and MCP templates into canonical store", async () => {
    const { home, root } = await makeTempRoot();

    const skill = await installRemoteItem({
      ref: "facult:skill-template",
      as: "shipping-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });
    expect(skill.type).toBe("skill");
    const skillPath = join(root, "skills", "shipping-skill", "SKILL.md");
    const skillMd = await readFile(skillPath, "utf8");
    expect(skillMd).toContain("# shipping-skill");

    const mcp = await installRemoteItem({
      ref: "facult:mcp-stdio-template",
      as: "github",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });
    expect(mcp.type).toBe("mcp");
    const servers = JSON.parse(
      await readFile(join(root, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { command?: string }>;
    };
    expect(servers.servers.github?.command).toBe("node");

    const index = JSON.parse(
      await readFile(facultAiIndexPath(home), "utf8")
    ) as {
      skills: Record<string, unknown>;
      mcp: { servers: Record<string, unknown> };
    };
    expect(Boolean(index.skills["shipping-skill"])).toBe(true);
    expect(Boolean(index.mcp.servers.github)).toBe(true);
  });

  it("detects and applies updates from configured file-based indices", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "local-index.json");
    const writeIndex = async (version: string, heading: string) => {
      const manifest = {
        name: "local",
        items: [
          {
            id: "ops-skill",
            type: "skill",
            version,
            skill: {
              name: "ops-skill",
              files: {
                "SKILL.md": `# ${heading}\n`,
              },
            },
          },
        ],
      };
      await writeFile(indexPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };

    await writeIndex("1.0.0", "v1");
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [{ name: "local", url: indexPath }],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "local:ops-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    await writeIndex("1.1.0", "v2");
    const report = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      apply: false,
    });
    expect(report.checks.some((c) => c.status === "outdated")).toBe(true);

    const applied = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      apply: true,
    });
    expect(applied.applied.length).toBe(1);

    const next = await readFile(
      join(root, "skills", "ops-skill", "SKILL.md"),
      "utf8"
    );
    expect(next).toContain("# v2");
  });

  it("verifies checksum-pinned manifest sources before install", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "integrity-index.json");
    const manifest = {
      items: [
        {
          id: "safe-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "safe-skill",
            files: {
              "SKILL.md": "# safe-skill\n",
            },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "integrity-local",
              url: indexPath,
              integrity: `sha256:${sha256Hex(manifestText)}`,
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "integrity-local:safe-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    expect(
      await Bun.file(join(root, "skills", "safe-skill", "SKILL.md")).exists()
    ).toBe(true);
  });

  it("rejects installs when pinned manifest integrity does not match", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "integrity-index.json");
    await writeFile(
      indexPath,
      `${JSON.stringify(
        {
          items: [
            {
              id: "safe-skill",
              type: "skill",
              version: "1.0.0",
              skill: {
                name: "safe-skill",
                files: {
                  "SKILL.md": "# safe-skill\n",
                },
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "integrity-local",
              url: indexPath,
              integrity:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "integrity-local:safe-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(INTEGRITY_CHECK_FAILED_RE);
  });

  it("verifies ed25519-signed manifest sources before install", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const publicKeyPath = join(home, "index-signing.pub");
    await writeFile(publicKeyPath, publicKeyPem);

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "signed-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "signed-skill",
            files: {
              "SKILL.md": "# signed-skill\n",
            },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                publicKeyPath,
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "signed-local:signed-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    expect(
      await Bun.file(join(root, "skills", "signed-skill", "SKILL.md")).exists()
    ).toBe(true);
  });

  it("rejects installs when pinned manifest signature does not match", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const publicKeyPath = join(home, "index-signing.pub");
    await writeFile(publicKeyPath, publicKeyPem);

    const indexPath = join(home, "signed-index.json");
    const initialManifest = {
      items: [
        {
          id: "signed-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "signed-skill",
            files: {
              "SKILL.md": "# signed-skill\n",
            },
          },
        },
      ],
    };
    const initialText = `${JSON.stringify(initialManifest, null, 2)}\n`;
    const signature = sign(null, Buffer.from(initialText), privateKey).toString(
      "base64"
    );

    const tamperedManifest = {
      items: [
        {
          id: "signed-skill",
          type: "skill",
          version: "9.9.9",
          skill: {
            name: "signed-skill",
            files: {
              "SKILL.md": "# tampered\n",
            },
          },
        },
      ],
    };
    await writeFile(
      indexPath,
      `${JSON.stringify(tamperedManifest, null, 2)}\n`
    );

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                publicKeyPath,
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "signed-local:signed-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(SIGNATURE_CHECK_FAILED_RE);
  });

  it("supports keyId selection when multiple signature keys are configured", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    const keyAPath = join(home, "index-signing-a.pub");
    const keyBPath = join(home, "index-signing-b.pub");
    await writeFile(
      keyAPath,
      keyA.publicKey.export({ type: "spki", format: "pem" }).toString()
    );
    await writeFile(
      keyBPath,
      keyB.publicKey.export({ type: "spki", format: "pem" }).toString()
    );

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "keyid-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "keyid-skill",
            files: { "SKILL.md": "# keyid-skill\n" },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      keyB.privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          signatureKeys: [
            { id: "a", publicKeyPath: keyAPath, status: "active" },
            { id: "b", publicKeyPath: keyBPath, status: "active" },
          ],
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                keyId: "b",
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "signed-local:keyid-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    expect(
      await Bun.file(join(root, "skills", "keyid-skill", "SKILL.md")).exists()
    ).toBe(true);
  });

  it("rejects signature verification when multiple keys are configured without keyId", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    const keyAPath = join(home, "index-signing-a.pub");
    const keyBPath = join(home, "index-signing-b.pub");
    await writeFile(
      keyAPath,
      keyA.publicKey.export({ type: "spki", format: "pem" }).toString()
    );
    await writeFile(
      keyBPath,
      keyB.publicKey.export({ type: "spki", format: "pem" }).toString()
    );

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "ambiguous-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "ambiguous-skill",
            files: { "SKILL.md": "# ambiguous-skill\n" },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      keyB.privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          signatureKeys: [
            { id: "a", publicKeyPath: keyAPath, status: "active" },
            { id: "b", publicKeyPath: keyBPath, status: "active" },
          ],
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "signed-local:ambiguous-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(MULTIPLE_SIGNATURE_KEYS_RE);
  });

  it("rejects signature verification when referenced keyId is revoked", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const key = generateKeyPairSync("ed25519");
    const keyPath = join(home, "index-signing-revoked.pub");
    await writeFile(
      keyPath,
      key.publicKey.export({ type: "spki", format: "pem" }).toString()
    );

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "revoked-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "revoked-skill",
            files: { "SKILL.md": "# revoked-skill\n" },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      key.privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          signatureKeys: [
            { id: "team-key", publicKeyPath: keyPath, status: "revoked" },
          ],
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                keyId: "team-key",
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "signed-local:revoked-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(REVOKED_SIGNATURE_KEY_RE);
  });

  it("supports smithery alias search/install without local index config", async () => {
    const { home, root } = await makeTempRoot();
    const requests: string[] = [];

    const rows = await searchRemoteItems({
      query: "github",
      index: "smithery",
      homeDir: home,
      cwd: home,
      fetchJson: (url) => {
        requests.push(url);
        return Promise.resolve({
          servers: [
            {
              qualifiedName: "github",
              displayName: "GitHub",
              description: "GitHub MCP",
              homepage: "https://smithery.ai/servers/github",
              verified: true,
              remote: true,
            },
          ],
        });
      },
    });

    expect(rows.length).toBe(1);
    expect(rows[0]?.index).toBe("smithery");
    expect(rows[0]?.item.id).toBe("github");
    expect(requests.some((url) => url.includes("/servers"))).toBe(true);

    await installRemoteItem({
      ref: "smithery:github",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () =>
        Promise.resolve({
          qualifiedName: "github",
          displayName: "GitHub",
          version: "1.2.3",
          homepage: "https://smithery.ai/servers/github",
          deploymentUrl: "https://github.run.tools",
          connections: [
            {
              type: "http",
              deploymentUrl: "https://github.run.tools",
              configSchema: {
                type: "object",
                required: ["GITHUB_TOKEN"],
                properties: {
                  GITHUB_TOKEN: { type: "string" },
                },
              },
            },
          ],
        }),
    });

    const mcp = JSON.parse(
      await readFile(join(root, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { url?: string; env?: Record<string, string> }>;
    };
    expect(mcp.servers.github?.url).toBe("https://github.run.tools/mcp");
    expect(mcp.servers.github?.env?.GITHUB_TOKEN).toBe("<set-me>");
  });

  it("installs glama items as MCP scaffolds and checks provider-based updates", async () => {
    const { home, root } = await makeTempRoot();

    await installRemoteItem({
      ref: "glama:systeminit/si",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () =>
        Promise.resolve({
          id: "e2dlqxr1fd",
          name: "System Initiative",
          namespace: "systeminit",
          slug: "si",
          version: "1.0.0",
          description: "System Initiative MCP",
          url: "https://glama.ai/mcp/servers/e2dlqxr1fd",
          attributes: ["hosting:hybrid"],
          environmentVariablesJsonSchema: {
            type: "object",
            required: ["SI_API_TOKEN"],
            properties: {
              SI_API_TOKEN: { type: "string" },
            },
          },
        }),
    });

    const mcp = JSON.parse(
      await readFile(join(root, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<
        string,
        { command?: string; env?: Record<string, string> }
      >;
    };
    expect(mcp.servers.si?.command).toBe("<set-command>");
    expect(mcp.servers.si?.env?.SI_API_TOKEN).toBe("<set-me>");

    const report = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () =>
        Promise.resolve({
          id: "e2dlqxr1fd",
          name: "System Initiative",
          namespace: "systeminit",
          slug: "si",
          version: "1.1.0",
          description: "System Initiative MCP",
          url: "https://glama.ai/mcp/servers/e2dlqxr1fd",
          attributes: ["hosting:hybrid"],
          environmentVariablesJsonSchema: {
            type: "object",
            required: ["SI_API_TOKEN"],
            properties: {
              SI_API_TOKEN: { type: "string" },
            },
          },
        }),
    });
    expect(report.checks.some((c) => c.status === "outdated")).toBe(true);
  });

  it("supports clawhub alias search/install/update for skill providers", async () => {
    const { home, root } = await makeTempRoot();

    const rows = await searchRemoteItems({
      query: "release",
      index: "clawhub",
      homeDir: home,
      cwd: home,
      fetchJson: (url) => {
        if (url.includes("/skills?")) {
          return Promise.resolve({
            items: [
              {
                slug: "release-checklist",
                name: "Release Checklist",
                description: "Release operations skill",
                latestVersion: "1.0.0",
                sourceUrl: "https://github.com/acme/release-checklist",
              },
            ],
          });
        }
        if (url.includes("/skills/release-checklist")) {
          return Promise.resolve({
            slug: "release-checklist",
            name: "Release Checklist",
            description: "Release operations skill",
            latestVersion: "1.0.0",
            sourceUrl: "https://github.com/acme/release-checklist",
          });
        }
        if (url.includes("/versions/1.0.0")) {
          return Promise.resolve({
            files: ["SKILL.md", "references/checklist.md"],
          });
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      },
      fetchText: (url) => {
        if (url.includes("path=SKILL.md")) {
          return Promise.resolve("# Release Checklist\n");
        }
        if (url.includes("path=references%2Fchecklist.md")) {
          return Promise.resolve("Use this checklist before release.\n");
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      },
    });

    expect(rows.some((row) => row.item.id === "release-checklist")).toBe(true);

    await installRemoteItem({
      ref: "clawhub:release-checklist",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: (url) => {
        if (url.includes("/skills/release-checklist/versions/1.0.0")) {
          return Promise.resolve({
            files: ["SKILL.md", "references/checklist.md"],
          });
        }
        if (url.includes("/skills/release-checklist")) {
          return Promise.resolve({
            slug: "release-checklist",
            name: "Release Checklist",
            description: "Release operations skill",
            latestVersion: "1.0.0",
            sourceUrl: "https://github.com/acme/release-checklist",
          });
        }
        return Promise.resolve({});
      },
      fetchText: (url) => {
        if (url.includes("path=SKILL.md")) {
          return Promise.resolve("# Release Checklist\n");
        }
        if (url.includes("path=references%2Fchecklist.md")) {
          return Promise.resolve("Use this checklist before release.\n");
        }
        return Promise.resolve("");
      },
    });

    expect(
      await Bun.file(
        join(root, "skills", "release-checklist", "SKILL.md")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(root, "skills", "release-checklist", "references", "checklist.md")
      ).exists()
    ).toBe(true);

    const report = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: (url) => {
        if (url.includes("/skills/release-checklist")) {
          return Promise.resolve({
            slug: "release-checklist",
            name: "Release Checklist",
            description: "Release operations skill",
            latestVersion: "1.1.0",
            sourceUrl: "https://github.com/acme/release-checklist",
          });
        }
        return Promise.resolve({});
      },
      fetchText: () => Promise.resolve(""),
    });

    expect(report.checks.some((check) => check.status === "outdated")).toBe(
      true
    );
  });

  it("supports skills.sh alias search/install with github raw fallback", async () => {
    const { home, root } = await makeTempRoot();
    const html = `<html><body>{"source":"https://github.com/acme/deploy-skill","skillId":"acme/deploy-skill","name":"Deploy Skill","description":"Ship safely"}</body></html>`;

    const rows = await searchRemoteItems({
      query: "deploy",
      index: "skills.sh",
      homeDir: home,
      cwd: home,
      fetchJson: () => Promise.resolve({}),
      fetchText: () => Promise.resolve(html),
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.item.id).toBe("acme/deploy-skill");
    expect(rows[0]?.item.type).toBe("skill");

    await installRemoteItem({
      ref: "skills.sh:acme/deploy-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () => Promise.resolve({}),
      fetchText: (url) => {
        if (url.includes("skills.sh")) {
          return Promise.resolve(html);
        }
        if (
          url.includes(
            "raw.githubusercontent.com/acme/deploy-skill/main/SKILL.md"
          )
        ) {
          return Promise.resolve("# Deploy Skill\n\nUse safe deploy steps.\n");
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      },
    });

    const skill = await readFile(
      join(root, "skills", "deploy-skill", "SKILL.md"),
      "utf8"
    );
    expect(skill).toContain("# Deploy Skill");
  });

  it("enforces source trust policies for install and update checks", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "local-index.json");
    await writeFile(
      indexPath,
      `${JSON.stringify(
        {
          items: [
            {
              id: "ops-skill",
              type: "skill",
              version: "1.0.0",
              skill: {
                name: "ops-skill",
                files: {
                  "SKILL.md": "# Ops Skill\n",
                },
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [{ name: "local", url: indexPath }],
        },
        null,
        2
      )}\n`
    );

    await withMutedConsole(async () => {
      await sourcesCommand(["block", "local"], { homeDir: home, cwd: home });
    });

    await expect(
      installRemoteItem({
        ref: "local:ops-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(BLOCKED_BY_POLICY_RE);

    await withMutedConsole(async () => {
      await sourcesCommand(["trust", "local"], { homeDir: home, cwd: home });
    });

    await installRemoteItem({
      ref: "local:ops-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    await withMutedConsole(async () => {
      await sourcesCommand(["review", "local"], { homeDir: home, cwd: home });
    });

    await expect(
      installRemoteItem({
        ref: "local:ops-skill",
        as: "ops-skill-strict",
        strictSourceTrust: true,
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(REQUIRES_REVIEW_RE);

    await withMutedConsole(async () => {
      await sourcesCommand(["block", "local"], { homeDir: home, cwd: home });
    });
    const blockedReport = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      apply: true,
    });
    expect(
      blockedReport.checks.some((check) => check.status === "blocked-source")
    ).toBe(true);

    await withMutedConsole(async () => {
      await sourcesCommand(["review", "local"], { homeDir: home, cwd: home });
    });
    const strictReport = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      strictSourceTrust: true,
    });
    expect(
      strictReport.checks.some((check) => check.status === "review-source")
    ).toBe(true);
  });
});

describe("templates command", () => {
  it("scaffolds templates through the DX command", async () => {
    const { home, root } = await makeTempRoot();
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(["init", "skill", "dx-skill"], {
        homeDir: home,
        rootDir: root,
        cwd: home,
      });
      await templatesCommand(["init", "agents"], {
        homeDir: home,
        rootDir: root,
        cwd: home,
      });
      await templatesCommand(["init", "agent", "code-reviewer"], {
        homeDir: home,
        rootDir: root,
        cwd: home,
      });
      await templatesCommand(["init", "instruction", "LANGUAGE"], {
        homeDir: home,
        rootDir: root,
        cwd: home,
      });
    });

    expect(
      await Bun.file(join(root, "skills", "dx-skill", "SKILL.md")).exists()
    ).toBe(true);
    expect(await Bun.file(join(root, "agents", "AGENTS.md")).exists()).toBe(
      true
    );
    expect(
      await Bun.file(
        join(root, "agents", "code-reviewer", "agent.toml")
      ).exists()
    ).toBe(true);
    const agentText = await Bun.file(
      join(root, "agents", "code-reviewer", "agent.toml")
    ).text();
    expect(agentText).toContain('name = "code-reviewer"');
    const instructionText = await Bun.file(
      join(root, "instructions", "LANGUAGE.md")
    ).text();
    expect(instructionText).toContain("# LANGUAGE");
    expect(instructionText).toContain("@ai/instructions/VERIFICATION.md");
    expect(instructionText).toContain(
      "fclt ai writeback add --kind missing_context"
    );
    const installed = JSON.parse(
      await Bun.file(join(root, "remote", "installed.json")).text()
    ) as { items: Array<{ type: string; installedAs: string }> };
    expect(
      installed.items.some(
        (item) =>
          item.type === "instruction" && item.installedAs === "LANGUAGE.md"
      )
    ).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("honors --root for shared template scaffolds", async () => {
    const { home } = await makeTempRoot();
    const root = join(home, "custom-ai");
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(
        ["init", "instruction", "--root", root, "LANGUAGE"],
        {
          homeDir: home,
          cwd: home,
        }
      );
    });

    expect(
      await Bun.file(join(root, "instructions", "LANGUAGE.md")).exists()
    ).toBe(true);
    expect(
      await Bun.file(join(home, ".ai", "instructions", "LANGUAGE.md")).exists()
    ).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it("scaffolds codex automation templates", async () => {
    const { home, root } = await makeTempRoot();
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "automation",
          "learning-review",
          "--name",
          "facult-daily",
          "--scope",
          "wide",
        ],
        {
          homeDir: home,
          rootDir: root,
          cwd: home,
        }
      );
    });

    const automationDir = join(home, ".codex", "automations", "facult-daily");
    const automationToml = await readFile(
      join(automationDir, "automation.toml"),
      "utf8"
    );
    expect(automationToml).toContain('id = "facult-daily"');
    expect(automationToml).toContain('status = "PAUSED"');
    expect(automationToml).toContain("rrule = ");
    expect(automationToml).toContain('model = "gpt-5.4"');
    expect(automationToml).toContain('reasoning_effort = "high"');
    expect(automationToml).toContain(join(home, ".codex", "AGENTS.md"));
    expect(automationToml).toContain(
      join(home, ".ai", "instructions", "LEARNING_AND_WRITEBACK.md")
    );
    expect(automationToml).toContain(
      join(home, ".ai", "instructions", "EVOLUTION.md")
    );
    expect(automationToml).toContain("$feedback-loop-setup");
    expect(automationToml).toContain("$capability-evolution");
    expect(automationToml).toContain("learning-extractor");
    expect(automationToml).toContain("writeback-curator");
    expect(automationToml).toContain("scope-promoter");
    expect(automationToml).toContain("evolution-planner");
    expect(automationToml).toContain("verification-auditor");
    expect(automationToml).toContain("fclt project init --json");
    expect(automationToml).toContain("blocked by missing project AI state");
    expect(automationToml).toContain("not graph-backed");
    expect(automationToml).toContain("Recorded writebacks");
    expect(await Bun.file(join(automationDir, "memory.md")).exists()).toBe(
      true
    );
    const memory = await readFile(join(automationDir, "memory.md"), "utf8");
    expect(memory).toContain("$feedback-loop-setup");
    expect(memory).toContain("$capability-evolution");
    expect(memory).toContain("preview baseline project AI state");
  });

  it("supports project-scoped automation scaffolding with explicit scope root", async () => {
    const { home, root } = await makeTempRoot();
    const projectRoot = join(home, "repo");
    await mkdir(projectRoot, { recursive: true });
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "automation",
          "tool-call-audit",
          "--project-root",
          projectRoot,
          "--name",
          "tool-audit",
          "--scope",
          "project",
          "--rrule",
          "RRULE:FREQ=WEEKLY;BYHOUR=10;BYMINUTE=30;BYDAY=MO",
        ],
        {
          homeDir: home,
          rootDir: root,
          cwd: home,
        }
      );
    });

    const automationDir = join(home, ".codex", "automations", "tool-audit");
    const automationToml = await readFile(
      join(automationDir, "automation.toml"),
      "utf8"
    );
    expect(automationToml).toContain('name = "Tool Call Audit"');
    expect(automationToml).toContain(
      'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=10;BYMINUTE=30;BYDAY=MO"'
    );
    expect(automationToml).toContain('model = "gpt-5.4"');
    expect(automationToml).toContain('reasoning_effort = "high"');
    expect(automationToml).toContain(join(home, ".codex", "AGENTS.md"));
    expect(automationToml).toContain(
      join(home, ".ai", "instructions", "LEARNING_AND_WRITEBACK.md")
    );
    expect(automationToml).toContain(
      join(home, ".ai", "instructions", "EVOLUTION.md")
    );
    expect(automationToml).toContain("$feedback-loop-setup");
    expect(automationToml).toContain("$capability-evolution");
    expect(automationToml).toContain("verification-auditor");
    expect(automationToml).toContain("evolution-planner");
    expect(automationToml).toContain("Operational gaps");
    expect(automationToml).toContain(`cwds = ["${projectRoot}"]`);
  });

  it("supports global automation scaffolding and aliases scope to wide", async () => {
    const { home, root } = await makeTempRoot();
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "automation",
          "learning-review",
          "--scope",
          "global",
          "--name",
          "global-learning",
        ],
        {
          homeDir: home,
          rootDir: root,
          cwd: home,
        }
      );
    });

    const automationDir = join(
      home,
      ".codex",
      "automations",
      "global-learning"
    );
    const automationToml = await readFile(
      join(automationDir, "automation.toml"),
      "utf8"
    );
    expect(automationToml).toContain('id = "global-learning"');
    expect(automationToml).toContain("cwds = []");
  });

  it("supports explicit cwds for wide/global automation scaffolding", async () => {
    const { home, root } = await makeTempRoot();
    const repoA = join(home, "repo-a");
    const repoB = join(home, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "automation",
          "learning-review",
          "--scope",
          "wide",
          "--name",
          "multi-repo-learning",
          "--cwds",
          `${repoA}, ${repoB}`,
        ],
        {
          homeDir: home,
          rootDir: root,
          cwd: home,
        }
      );
    });

    const automationDir = join(
      home,
      ".codex",
      "automations",
      "multi-repo-learning"
    );
    const automationToml = await readFile(
      join(automationDir, "automation.toml"),
      "utf8"
    );
    expect(automationToml).toContain('id = "multi-repo-learning"');
    expect(automationToml).toContain(`cwds = ["${repoA}", "${repoB}"]`);
  });

  it("scaffolds the weekly evolution review automation template", async () => {
    const { home, root } = await makeTempRoot();
    const repoA = join(home, "repo-a");
    const repoB = join(home, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "automation",
          "evolution-review",
          "--scope",
          "wide",
          "--name",
          "weekly-evolution",
          "--cwds",
          `${repoA},${repoB}`,
        ],
        {
          homeDir: home,
          rootDir: root,
          cwd: home,
        }
      );
    });

    const automationDir = join(
      home,
      ".codex",
      "automations",
      "weekly-evolution"
    );
    const automationToml = await readFile(
      join(automationDir, "automation.toml"),
      "utf8"
    );
    expect(automationToml).toContain('name = "Evolution Review Loop"');
    expect(automationToml).toContain(
      'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=16;BYMINUTE=0;BYDAY=FR"'
    );
    expect(automationToml).toContain("$capability-evolution");
    expect(automationToml).toContain("scope-promoter");
    expect(automationToml).toContain("Recommended actions");
    expect(automationToml).toContain("Hold or reject");
    expect(automationToml).toContain(`cwds = ["${repoA}", "${repoB}"]`);

    const memory = await readFile(join(automationDir, "memory.md"), "utf8");
    expect(memory).toContain("keep proposal review moving");
    expect(memory).toContain("$capability-evolution");
    expect(memory).toContain("Recommend actions, do not silently apply");
  });

  it("uses the selected project cwd for a project closed-loop template", async () => {
    const { home, root } = await makeTempRoot();
    const repo = join(home, "project with spaces");
    await mkdir(join(repo, ".ai"), { recursive: true });

    await withMutedConsole(async () => {
      await templatesCommand(
        ["init", "automation", "closed-loop-review", "--scope", "project"],
        { homeDir: home, rootDir: root, cwd: repo }
      );
    });

    const automationToml = await readFile(
      join(
        home,
        ".codex",
        "automations",
        "closed-loop-review",
        "automation.toml"
      ),
      "utf8"
    );
    expect(automationToml).toContain(`cwds = ["${repo}"]`);
    expect(automationToml).toContain(
      `fclt ai loop run --project --root '${join(repo, ".ai")}' --scheduled --json`
    );
    expect(automationToml).not.toContain(`--project --root '${root}'`);

    await expect(
      scaffoldCodexAutomationTemplate({
        homeDir: home,
        cwd: repo,
        templateId: "closed-loop-review",
        scope: "project",
        rootDir: root,
        name: "mismatched-project-loop",
      })
    ).rejects.toThrow("must match the selected project root");

    const normalized = await scaffoldCodexAutomationTemplate({
      homeDir: home,
      cwd: repo,
      templateId: "closed-loop-review",
      scope: " PROJECT ",
      rootDir: join(repo, ".ai"),
      name: "normalized-project-loop",
    });
    expect(
      await readFile(join(normalized.path, "automation.toml"), "utf8")
    ).toContain(
      `fclt ai loop run --project --root '${join(repo, ".ai")}' --scheduled --json`
    );

    await expect(
      scaffoldCodexAutomationTemplate({
        homeDir: home,
        cwd: repo,
        templateId: "closed-loop-review",
        scope: " WIDE ",
        name: "normalized-wide-loop",
      })
    ).rejects.toThrow("wide scope is not supported");

    const wide = await withCapturedConsole(async () => {
      await templatesCommand(
        ["init", "automation", "closed-loop-review", "--scope", "wide"],
        { homeDir: home, rootDir: root, cwd: repo }
      );
    });
    expect(wide.errors.join("\n")).toContain("wide scope is not supported");
    expect(process.exitCode).toBe(1);
  });

  it("honors an explicit root for a global closed-loop template", async () => {
    const { home } = await makeTempRoot();
    const customRoot = join(home, "shared capability", ".ai");

    await withMutedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "automation",
          "closed-loop-review",
          "--scope",
          "global",
          "--root",
          customRoot,
        ],
        { homeDir: home, cwd: home }
      );
    });

    const automationToml = await readFile(
      join(
        home,
        ".codex",
        "automations",
        "closed-loop-review",
        "automation.toml"
      ),
      "utf8"
    );
    expect(automationToml).toContain(
      `fclt ai loop run --global --root '${customRoot}' --scheduled --json`
    );
    expect(automationToml).not.toContain(
      `fclt ai loop run --global --root '${join(home, ".ai")}'`
    );
    expect(process.exitCode).toBe(0);
  });

  it("resolves CLI-style roots for global closed-loop templates", async () => {
    const { home } = await makeTempRoot();
    const cwd = join(home, "workspace");
    await mkdir(cwd, { recursive: true });

    await withMutedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "automation",
          "closed-loop-review",
          "--scope",
          "global",
          "--root",
          "~/shared/.ai",
          "--name",
          "home-relative-loop",
        ],
        { homeDir: home, cwd }
      );
      await templatesCommand(
        [
          "init",
          "automation",
          "closed-loop-review",
          "--scope",
          "global",
          "--root",
          "local/.ai",
          "--name",
          "cwd-relative-loop",
        ],
        { homeDir: home, cwd }
      );
    });

    const homeRelative = await readFile(
      join(
        home,
        ".codex",
        "automations",
        "home-relative-loop",
        "automation.toml"
      ),
      "utf8"
    );
    expect(homeRelative).toContain(
      `fclt ai loop run --global --root '${join(home, "shared", ".ai")}' --scheduled --json`
    );

    const cwdRelative = await readFile(
      join(
        home,
        ".codex",
        "automations",
        "cwd-relative-loop",
        "automation.toml"
      ),
      "utf8"
    );
    expect(cwdRelative).toContain(
      `fclt ai loop run --global --root '${join(cwd, "local", ".ai")}' --scheduled --json`
    );
    expect(process.exitCode).toBe(0);
  });

  it("refuses automation scaffold and status writes through a symlinked directory", async () => {
    const { home } = await makeTempRoot();
    const automationRoot = join(home, ".codex", "automations");
    const outside = join(home, "outside-automation");
    await mkdir(automationRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await Bun.write(
      join(outside, "automation.toml"),
      [
        "version = 1",
        'id = "unsafe-loop"',
        'managed_by = "fclt-evolution-loop"',
        'status = "ACTIVE"',
        "updated_at = 1",
        "",
      ].join("\n")
    );
    await symlink(outside, join(automationRoot, "unsafe-loop"));

    await expect(
      scaffoldCodexAutomationTemplate({
        homeDir: home,
        cwd: home,
        templateId: "evolution-review",
        name: "unsafe-loop",
      })
    ).rejects.toThrow("unsafe Codex automation directory");
    await expect(
      setCodexAutomationStatus({
        homeDir: home,
        name: "unsafe-loop",
        status: "PAUSED",
      })
    ).rejects.toThrow("unsafe Codex automation directory");
    expect(await readFile(join(outside, "automation.toml"), "utf8")).toContain(
      'status = "ACTIVE"'
    );
  });

  it("previews minimal project-ai enrollment without writing", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await initializeGitRepository(repoDir, home);
    process.chdir(repoDir);

    const { logs, errors } = await withCapturedConsole(async () => {
      await templatesCommand(["init", "project-ai"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    expect(errors).toEqual([]);
    const plan = JSON.parse(logs.join("\n")) as {
      projectRoot: string;
      protections: { automaticGuidanceCopy: boolean };
      canonicalWrites: Array<{ path: string }>;
    };
    expect(plan.projectRoot).toBe(repoDir);
    expect(plan.protections.automaticGuidanceCopy).toBe(false);
    expect(plan.canonicalWrites.map((write) => write.path)).toEqual([
      join(repoDir, ".ai", ".gitignore"),
      join(repoDir, ".ai", "config.toml"),
    ]);
    expect(await Bun.file(join(repoDir, ".ai")).exists()).toBe(false);
  });

  it("keeps project-ai alias apply zero-write under common --dry-run", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await initializeGitRepository(repoDir, home);

    const previewOutput = await withCapturedConsole(async () => {
      await templatesCommand(
        ["init", "project-ai", "--project-root", repoDir, "--json"],
        {
          homeDir: home,
          cwd: repoDir,
        }
      );
    });
    expect(previewOutput.errors).toEqual([]);
    const plan = JSON.parse(previewOutput.logs.join("\n")) as {
      planSha256: string;
      canonicalWrites: Array<{ path: string }>;
      generatedWrites: Array<{ path: string }>;
      machineLocalWrites: Array<{ path: string }>;
    };

    const dryRunOutput = await withCapturedConsole(async () => {
      await templatesCommand(
        [
          "init",
          "project-ai",
          "--project-root",
          repoDir,
          "--apply",
          "--plan-sha",
          plan.planSha256,
          "--dry-run",
          "--json",
        ],
        {
          homeDir: home,
          cwd: repoDir,
        }
      );
    });

    expect(dryRunOutput.errors).toEqual([]);
    expect(
      (JSON.parse(dryRunOutput.logs.join("\n")) as { planSha256: string })
        .planSha256
    ).toBe(plan.planSha256);
    expect(await Bun.file(join(repoDir, ".ai")).exists()).toBe(false);
    expect(await Bun.file(facultLocalStateRoot(home)).exists()).toBe(false);
    for (const pathValue of [
      ...plan.canonicalWrites,
      ...plan.generatedWrites,
      ...plan.machineLocalWrites,
    ].map((write) => write.path)) {
      expect(await Bun.file(pathValue).exists()).toBe(false);
    }
  });

  it("previews project-ai enrollment into an explicit root", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const otherDir = join(home, "other");
    await initializeGitRepository(repoDir, home);
    await mkdir(otherDir, { recursive: true });

    const { logs } = await withCapturedConsole(async () => {
      await templatesCommand(
        ["init", "project-ai", "--root", join(repoDir, ".ai")],
        {
          homeDir: home,
          cwd: otherDir,
        }
      );
    });

    expect(
      (JSON.parse(logs.join("\n")) as { projectRoot: string }).projectRoot
    ).toBe(repoDir);
    expect(await Bun.file(join(repoDir, ".ai")).exists()).toBe(false);
    expect(await Bun.file(join(otherDir, ".ai")).exists()).toBe(false);
  });

  it("previews project-ai enrollment from an explicit project root", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const otherDir = join(home, "other");
    await initializeGitRepository(repoDir, home);
    await mkdir(otherDir, { recursive: true });

    const { logs } = await withCapturedConsole(async () => {
      await templatesCommand(
        ["init", "project-ai", "--project-root", repoDir],
        {
          homeDir: home,
          cwd: otherDir,
        }
      );
    });

    expect(
      (JSON.parse(logs.join("\n")) as { projectRoot: string }).projectRoot
    ).toBe(repoDir);
    expect(await Bun.file(join(repoDir, ".ai")).exists()).toBe(false);
    expect(await Bun.file(join(otherDir, ".ai")).exists()).toBe(false);
  });

  it("prefers explicit project roots over inferred template roots for project-ai", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const otherDir = join(home, "other");
    await initializeGitRepository(repoDir, home);
    await mkdir(otherDir, { recursive: true });

    const { logs } = await withCapturedConsole(async () => {
      await templatesCommand(
        ["init", "project-ai", "--project-root", repoDir],
        {
          homeDir: home,
          cwd: otherDir,
          rootDir: join(otherDir, ".ai"),
        }
      );
    });

    expect(
      (JSON.parse(logs.join("\n")) as { projectRoot: string }).projectRoot
    ).toBe(repoDir);
    expect(await Bun.file(join(repoDir, ".ai")).exists()).toBe(false);
    expect(await Bun.file(join(otherDir, ".ai")).exists()).toBe(false);
  });

  it("expands home-relative project roots for project-ai", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const otherDir = join(home, "other");
    await initializeGitRepository(repoDir, home);
    await mkdir(otherDir, { recursive: true });

    const { logs } = await withCapturedConsole(async () => {
      await templatesCommand(["init", "project-ai", "--project-root=~/repo"], {
        homeDir: home,
        cwd: otherDir,
      });
    });

    expect(
      (JSON.parse(logs.join("\n")) as { projectRoot: string }).projectRoot
    ).toBe(repoDir);
    expect(await Bun.file(join(repoDir, ".ai")).exists()).toBe(false);
    expect(await Bun.file(join(otherDir, "~", "repo", ".ai")).exists()).toBe(
      false
    );
  });

  it("rejects project-ai project-root flags without values", async () => {
    const { home } = await makeTempRoot();
    const otherDir = join(home, "other");
    await mkdir(otherDir, { recursive: true });

    await expect(
      withMutedConsole(async () => {
        await templatesCommand(
          ["init", "project-ai", "--project-root", "--force"],
          {
            homeDir: home,
            cwd: otherDir,
          }
        );
      })
    ).rejects.toThrow("--project-root requires a path value");

    expect(await Bun.file(join(otherDir, "--force", ".ai")).exists()).toBe(
      false
    );
  });

  it("does not scaffold project-ai when help is requested", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await mkdir(repoDir, { recursive: true });

    await withMutedConsole(async () => {
      await templatesCommand(["init", "project-ai", "--help"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    expect(await Bun.file(join(repoDir, ".ai")).exists()).toBe(false);
  });

  it("installs the builtin operating-model pack into the global canonical root", async () => {
    const { home } = await makeTempRoot();
    const globalRoot = join(home, ".ai");

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--global"], {
        homeDir: home,
        cwd: home,
      });
    });

    expect(
      await Bun.file(join(globalRoot, "instructions", "WORK_UNITS.md")).exists()
    ).toBe(true);
    expect(
      await Bun.file(join(globalRoot, "instructions", "EVOLUTION.md")).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(globalRoot, "skills", "capability-evolution", "SKILL.md")
      ).exists()
    ).toBe(true);
    expect(await Bun.file(join(globalRoot, "AGENTS.global.md")).exists()).toBe(
      true
    );

    const agentsText = await Bun.file(
      join(globalRoot, "AGENTS.global.md")
    ).text();
    expect(agentsText).toContain(["$", "{refs.work_units}"].join(""));
    expect(agentsText).toContain("<!-- fclty:global/core/work-units -->");
    expect(
      await Bun.file(
        join(globalRoot, "snippets", "global", "core", "work-units.md")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(globalRoot, "snippets", "templates", "agents-global.md")
      ).exists()
    ).toBe(false);
    const withSnippets = await renderSnippetText({
      text: agentsText,
      rootDir: globalRoot,
    });
    const renderedAgentsText = await renderCanonicalText(withSnippets.text, {
      homeDir: home,
      rootDir: globalRoot,
    });
    expect(renderedAgentsText).toContain("WORK_UNITS.md");
    expect(renderedAgentsText).toContain("INTEGRATION.md");
    expect(renderedAgentsText).not.toContain(
      ["$", "{refs.integration}"].join("")
    );
    expect(await Bun.file(facultAiIndexPath(home, globalRoot)).exists()).toBe(
      true
    );
    const manifestPath = join(
      globalRoot,
      ".facult",
      "packs",
      "facult-operating-model.json"
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.pack).toBe("facult-operating-model");
    expect(manifest.files["AGENTS.global.md"].sha256).toBeString();
    expect(
      manifest.files["snippets/templates/agents-global.md"]
    ).toBeUndefined();
    expect(manifest.files["instructions/WORK_UNITS.md"].sha256).toBeString();
  });

  it("seeds global AGENTS.global.md from existing global agent guidance", async () => {
    const { home } = await makeTempRoot();
    const globalRoot = join(home, ".ai");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "AGENTS.md"),
      "# Existing Global Guidance\n\n- Preserve my current rules.\n"
    );

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--global"], {
        homeDir: home,
        cwd: home,
      });
    });

    const agentsPath = join(globalRoot, "AGENTS.global.md");
    const agentsText = await readFile(agentsPath, "utf8");
    expect(agentsText).toContain("# Existing Global Guidance");
    expect(agentsText).toContain("- Preserve my current rules.");
    expect(agentsText).toContain("## Facult Operating Model");
    expect(agentsText).toContain("<!-- fclty:global/core/work-units -->");

    const manifest = JSON.parse(
      await readFile(
        join(globalRoot, ".facult", "packs", "facult-operating-model.json"),
        "utf8"
      )
    );
    expect(manifest.files["AGENTS.global.md"]).toBeUndefined();

    await withMutedConsole(async () => {
      await templatesCommand(
        ["init", "operating-model", "--global", "--update"],
        {
          homeDir: home,
          cwd: home,
        }
      );
    });
    expect(await readFile(agentsPath, "utf8")).toBe(agentsText);
  });

  it("does not seed project AGENTS.global.md from repo guidance", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, "AGENTS.md"),
      "# Project Agent Instructions\n\n- Use repo-specific checks.\n"
    );
    process.chdir(repoDir);

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--project"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    const agentsText = await readFile(
      join(repoDir, ".ai", "AGENTS.global.md"),
      "utf8"
    );
    expect(agentsText).not.toContain("# Project Agent Instructions");
    expect(agentsText).not.toContain("- Use repo-specific checks.");
    expect(agentsText).toContain("# Global Agent Instructions");
    expect(agentsText).toContain("<!-- fclty:global/core/writeback -->");
    expect(
      await readFile(join(repoDir, ".ai", ".gitignore"), "utf8")
    ).toContain("/.facult/");
  });

  it("refuses a symlinked project ignore leaf before full-pack writes", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const victimPath = join(home, "victim.txt");
    await initializeGitRepository(repoDir, home);
    await mkdir(join(repoDir, ".ai"), { recursive: true });
    await writeFile(victimPath, "do not change\n", "utf8");
    await symlink(victimPath, join(repoDir, ".ai", ".gitignore"));

    const output = await withCapturedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--project"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    expect(process.exitCode).toBe(1);
    expect(output.errors.join("\n")).toContain(
      "Refusing unsafe project ignore file"
    );
    expect(await readFile(victimPath, "utf8")).toBe("do not change\n");
    expect(
      await Bun.file(join(repoDir, ".ai", "AGENTS.global.md")).exists()
    ).toBe(false);
    expect(await Bun.file(join(repoDir, ".ai", ".facult")).exists()).toBe(
      false
    );
  });

  it("refuses a hard-linked project ignore leaf without changing its peer", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const victimPath = join(home, "victim.txt");
    await initializeGitRepository(repoDir, home);
    await mkdir(join(repoDir, ".ai"), { recursive: true });
    await writeFile(victimPath, "do not change\n", "utf8");
    await link(victimPath, join(repoDir, ".ai", ".gitignore"));

    const output = await withCapturedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--project"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    expect(process.exitCode).toBe(1);
    expect(output.errors.join("\n")).toContain(
      "Refusing unsafe project ignore file"
    );
    expect(await readFile(victimPath, "utf8")).toBe("do not change\n");
    expect(
      await Bun.file(join(repoDir, ".ai", "AGENTS.global.md")).exists()
    ).toBe(false);
    expect(await Bun.file(join(repoDir, ".ai", ".facult")).exists()).toBe(
      false
    );
  });

  it("propagates project ignore access failures without treating authored rules as absent", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const aiRoot = join(repoDir, ".ai");
    const ignorePath = join(aiRoot, ".gitignore");
    await initializeGitRepository(repoDir, home);
    await mkdir(aiRoot, { recursive: true });
    await writeFile(ignorePath, "/authored-rule\n", "utf8");
    await chmod(aiRoot, 0o000);
    let failure: unknown;
    try {
      await scaffoldBuiltinOperatingModelPack({
        homeDir: home,
        rootDir: aiRoot,
      });
    } catch (error) {
      failure = error;
    } finally {
      await chmod(aiRoot, 0o700);
    }

    expect((failure as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
    expect(await readFile(ignorePath, "utf8")).toBe("/authored-rule\n");
    expect(await Bun.file(join(aiRoot, "AGENTS.global.md")).exists()).toBe(
      false
    );
  });

  it("refuses a special-file project ignore leaf without opening it", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const ignorePath = join(repoDir, ".ai", ".gitignore");
    await initializeGitRepository(repoDir, home);
    await mkdir(join(repoDir, ".ai"), { recursive: true });
    const fifo = Bun.spawnSync(["mkfifo", ignorePath]);
    expect(fifo.exitCode).toBe(0);

    const output = await withCapturedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--project"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    expect(process.exitCode).toBe(1);
    expect(output.errors.join("\n")).toContain(
      "Refusing unsafe project ignore file"
    );
    expect((await lstat(ignorePath)).isFIFO()).toBe(true);
    expect(
      await Bun.file(join(repoDir, ".ai", "AGENTS.global.md")).exists()
    ).toBe(false);
  });

  it("reappends full-pack protections after existing ignore negations", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await initializeGitRepository(repoDir, home);
    await mkdir(join(repoDir, ".ai"), { recursive: true });
    await writeFile(
      join(repoDir, ".ai", ".gitignore"),
      [
        "/.facult/",
        "!/.facult/",
        "/config.local.toml",
        "!/config.local.toml",
        "",
      ].join("\n"),
      "utf8"
    );

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--project"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    const ignore = await readFile(join(repoDir, ".ai", ".gitignore"), "utf8");
    expect(ignore.lastIndexOf("/.facult/")).toBeGreaterThan(
      ignore.lastIndexOf("!/.facult/")
    );
    expect(ignore.lastIndexOf("/config.local.toml")).toBeGreaterThan(
      ignore.lastIndexOf("!/config.local.toml")
    );
  });

  it("preserves existing project ignore mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const ignorePath = join(repoDir, ".ai", ".gitignore");
    await initializeGitRepository(repoDir, home);
    await mkdir(dirname(ignorePath), { recursive: true });
    await writeFile(ignorePath, "/authored-rule\n", "utf8");
    await chmod(ignorePath, 0o640);

    await scaffoldBuiltinOperatingModelPack({
      homeDir: home,
      rootDir: join(repoDir, ".ai"),
    });

    expect((await lstat(ignorePath)).mode % 0o1000).toBe(0o640);
  });

  it("creates a repo-readable project ignore despite a restrictive umask", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await initializeGitRepository(repoDir, home);

    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        'umask 077; exec bun run "$1" templates init operating-model --project',
        "sh",
        join(import.meta.dir, "index.ts"),
      ],
      {
        cwd: repoDir,
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(
      (await lstat(join(repoDir, ".ai", ".gitignore"))).mode % 0o1000
    ).toBe(0o644);
    expect(
      (
        await lstat(
          join(
            repoDir,
            ".ai",
            ".facult",
            "packs",
            "facult-operating-model.json"
          )
        )
      ).mode % 0o1000
    ).toBe(0o600);
  });

  it("updates unmodified builtin operating-model files using the pack manifest", async () => {
    const { home } = await makeTempRoot();
    const globalRoot = join(home, ".ai");

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--global"], {
        homeDir: home,
        cwd: home,
      });
    });

    const workUnitsPath = join(globalRoot, "instructions", "WORK_UNITS.md");
    const manifestPath = join(
      globalRoot,
      ".facult",
      "packs",
      "facult-operating-model.json"
    );
    const oldPackText = "# Work Units\n\nOld packaged copy.\n";
    await writeFile(workUnitsPath, oldPackText);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["instructions/WORK_UNITS.md"] = {
      sha256: sha256Hex(oldPackText),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await withMutedConsole(async () => {
      await templatesCommand(
        ["init", "operating-model", "--global", "--update"],
        {
          homeDir: home,
          cwd: home,
        }
      );
    });

    const updated = await readFile(workUnitsPath, "utf8");
    expect(updated).toContain("smallest coherent unit of agent work");
    expect(updated).not.toBe(oldPackText);
  });

  it("does not overwrite locally edited builtin operating-model files during update", async () => {
    const { home } = await makeTempRoot();
    const globalRoot = join(home, ".ai");

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--global"], {
        homeDir: home,
        cwd: home,
      });
    });

    const workUnitsPath = join(globalRoot, "instructions", "WORK_UNITS.md");
    const localEdit = "# Work Units\n\nLocal edited guidance.\n";
    await writeFile(workUnitsPath, localEdit);

    await withMutedConsole(async () => {
      await templatesCommand(
        ["init", "operating-model", "--global", "--update"],
        {
          homeDir: home,
          cwd: home,
        }
      );
    });

    expect(await readFile(workUnitsPath, "utf8")).toBe(localEdit);
  });

  it("repairs dangling legacy skill symlinks during setup", async () => {
    const { home } = await makeTempRoot();
    const globalRoot = join(home, ".ai");
    const skillPath = join(
      globalRoot,
      "skills",
      "project-operating-layer-design"
    );
    await mkdir(join(globalRoot, "skills"), { recursive: true });
    await symlink(join(home, "missing-legacy-checkout"), skillPath);

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--global"], {
        homeDir: home,
        cwd: home,
      });
    });

    expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toContain(
      "# project-operating-layer-design"
    );
  });

  it("preserves symlinks when target stat fails for a non-missing reason", async () => {
    const { home } = await makeTempRoot();
    const globalRoot = join(home, ".ai");
    const skillPath = join(
      globalRoot,
      "skills",
      "project-operating-layer-design"
    );
    await mkdir(join(globalRoot, "skills"), { recursive: true });
    await symlink(skillPath, skillPath);

    await expect(
      scaffoldBuiltinOperatingModelPack({
        homeDir: home,
        rootDir: globalRoot,
      })
    ).rejects.toThrow();
    expect((await lstat(skillPath)).isSymbolicLink()).toBe(true);
  });

  it("preserves a project ignore edited at the final commit boundary", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    const aiRoot = join(repoDir, ".ai");
    await mkdir(aiRoot, { recursive: true });
    const ignorePath = join(aiRoot, ".gitignore");
    const reviewedPath = join(aiRoot, ".gitignore.reviewed");
    await writeFile(ignorePath, "/before\n", "utf8");
    process.chdir(repoDir);

    await expect(
      scaffoldBuiltinOperatingModelPack({
        homeDir: home,
        rootDir: aiRoot,
        beforeProjectIgnoreCommit: async () => {
          await rename(ignorePath, reviewedPath);
          await writeFile(ignorePath, "/concurrent\n", "utf8");
        },
      })
    ).rejects.toThrow("conditional commit boundary");
    expect(await readFile(ignorePath, "utf8")).toBe("/concurrent\n");
    expect(await readFile(reviewedPath, "utf8")).toBe("/before\n");
  });

  it("bootstraps the builtin operating-model pack into a project root", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await mkdir(repoDir, { recursive: true });
    process.chdir(repoDir);

    await withMutedConsole(async () => {
      await templatesCommand(["init", "operating-model", "--project"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    const projectRoot = join(repoDir, ".ai");
    expect(
      await Bun.file(
        join(projectRoot, "instructions", "WORK_UNITS.md")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(
          projectRoot,
          "skills",
          "project-operating-layer-design",
          "SKILL.md"
        )
      ).exists()
    ).toBe(true);
    expect(await Bun.file(facultAiIndexPath(home, projectRoot)).exists()).toBe(
      true
    );
  });
});

describe("sources command", () => {
  it("lists default and explicit source policies", async () => {
    const { home } = await makeTempRoot();
    process.chdir(home);

    await mkdir(join(home, ".ai", ".facult"), { recursive: true });
    const indexPath = join(home, "local-index.json");
    await writeFile(indexPath, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    await writeFile(
      join(home, ".ai", ".facult", "indices.json"),
      `${JSON.stringify(
        {
          indices: [{ name: "local", url: indexPath }],
        },
        null,
        2
      )}\n`
    );

    await withMutedConsole(async () => {
      await sourcesCommand(["trust", "local", "--note", "reviewed"], {
        homeDir: home,
        cwd: home,
      });
    });

    const { logs, errors } = await withCapturedConsole(async () => {
      await sourcesCommand(["list", "--json"], {
        homeDir: home,
        cwd: home,
      });
    });
    expect(errors.length).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as {
      source: string;
      level: string;
      explicit: boolean;
      note?: string;
    }[];

    const local = parsed.find((row) => row.source === "local");
    expect(local?.level).toBe("trusted");
    expect(local?.explicit).toBe(true);
    expect(local?.note).toBe("reviewed");

    const builtin = parsed.find((row) => row.source === "facult");
    expect(builtin?.level).toBe("trusted");
    expect(builtin?.explicit).toBe(false);
  });
});

describe("verify-source command", () => {
  it("reports trust and integrity checks for manifest sources", async () => {
    const { home } = await makeTempRoot();
    process.chdir(home);

    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });
    const indexPath = join(home, "local-index.json");
    const manifestText = `${JSON.stringify(
      {
        items: [
          {
            id: "verify-skill",
            type: "skill",
            version: "1.0.0",
            skill: {
              name: "verify-skill",
              files: { "SKILL.md": "# verify\n" },
            },
          },
        ],
      },
      null,
      2
    )}\n`;
    await writeFile(indexPath, manifestText);
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "local",
              url: indexPath,
              integrity: `sha256:${sha256Hex(manifestText)}`,
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await withMutedConsole(async () => {
      await sourcesCommand(["trust", "local"], { homeDir: home, cwd: home });
    });

    const { logs, errors } = await withCapturedConsole(async () => {
      await verifySourceCommand(["local", "--json"], {
        homeDir: home,
        cwd: home,
      });
    });
    expect(errors.length).toBe(0);
    const report = JSON.parse(logs.join("\n")) as {
      source: { name: string; kind: string };
      trust: { level: string; explicit: boolean };
      checks: {
        fetch: string;
        parse: string;
        integrity: string;
        signature: string;
        items: number;
      };
      error?: string;
    };
    expect(report.source.name).toBe("local");
    expect(report.source.kind).toBe("manifest");
    expect(report.trust.level).toBe("trusted");
    expect(report.trust.explicit).toBe(true);
    expect(report.checks.fetch).toBe("passed");
    expect(report.checks.parse).toBe("passed");
    expect(report.checks.integrity).toBe("passed");
    expect(report.checks.signature).toBe("not-configured");
    expect(report.checks.items).toBe(1);
    expect(report.error).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("returns a failing status when verification checks fail", async () => {
    const { home } = await makeTempRoot();
    process.chdir(home);

    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });
    const indexPath = join(home, "local-index.json");
    await writeFile(indexPath, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "local",
              url: indexPath,
              integrity:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const { logs, errors } = await withCapturedConsole(async () => {
      await verifySourceCommand(["local", "--json"], {
        homeDir: home,
        cwd: home,
      });
    });
    expect(errors.length).toBe(0);
    const report = JSON.parse(logs.join("\n")) as {
      checks: { integrity: string };
      error?: string;
    };
    expect(report.checks.integrity).toBe("failed");
    expect(report.error).toMatch(INTEGRITY_CHECK_FAILED_RE);
    expect(process.exitCode).toBe(1);
  });
});
