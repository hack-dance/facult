import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  normalizeRepositoryRemote,
  type RepositoryCommonDirectoryMetadata,
  repositoryCommonDirectoryFingerprint,
  repositoryIdentityFromGitFacts,
} from "./repository-identity";

const BASE_METADATA: RepositoryCommonDirectoryMetadata = {
  birthtimeNs: 100n,
  ctimeNs: 200n,
  dev: 10n,
  ino: 20n,
};

function identityFor(metadata: RepositoryCommonDirectoryMetadata) {
  return repositoryIdentityFromGitFacts({
    commonDir: ".git",
    commonDirMetadata: metadata,
    projectRoot: "fixture/repo",
    rootCommit: "0123456789abcdef",
  });
}

describe("machine-local repository identity", () => {
  it("uses birth time to distinguish inode reuse while surviving a root rename", () => {
    const original = identityFor(BASE_METADATA);
    const recreated = identityFor({
      ...BASE_METADATA,
      birthtimeNs: BASE_METADATA.birthtimeNs + 1n,
    });
    const renamed = repositoryIdentityFromGitFacts({
      commonDir: ".git",
      commonDirMetadata: BASE_METADATA,
      projectRoot: "fixture/renamed-repo",
      rootCommit: "0123456789abcdef",
    });

    expect(original.kind).toBe("git-common-dir");
    expect(original.id).not.toBe(recreated.id);
    expect(renamed.id).toBe(original.id);
    expect(original.aliases).toEqual([
      expect.objectContaining({
        kind: "root-commit",
        stability: "portable",
      }),
    ]);
  });

  it("refuses mutable ctime when birth time is unavailable", () => {
    expect(() =>
      identityFor({
        ...BASE_METADATA,
        birthtimeNs: 0n,
        ctimeNs: 300n,
      })
    ).toThrow("birth time is unavailable");
    expect(() =>
      repositoryCommonDirectoryFingerprint({
        ...BASE_METADATA,
        birthtimeNs: 0n,
        ctimeNs: 0n,
      })
    ).toThrow("birth time is unavailable");
  });

  it("does not change identity when only mutable ctime changes", () => {
    const first = identityFor({
      ...BASE_METADATA,
      ctimeNs: 300n,
    });
    const afterGitMutation = identityFor({
      ...BASE_METADATA,
      ctimeNs: 301n,
    });

    expect(afterGitMutation.id).toBe(first.id);
  });

  it("does not expose the legacy dev-inode identity as an authorization alias", () => {
    const identity = identityFor(BASE_METADATA);
    const legacyId = `repo_${createHash("sha256")
      .update(`git-common-dir:${BASE_METADATA.dev}:${BASE_METADATA.ino}`)
      .digest("hex")
      .slice(0, 24)}`;

    expect([
      identity.id,
      ...identity.aliases.map((alias) => alias.id),
    ]).not.toContain(legacyId);
  });

  it("keeps a remote primary portable when common-directory creation changes", () => {
    const original = repositoryIdentityFromGitFacts({
      commonDir: ".git",
      commonDirMetadata: BASE_METADATA,
      originUrl: "https://github.com/example/project.git",
      projectRoot: "fixture/repo",
      rootCommit: "0123456789abcdef",
    });
    const recreated = repositoryIdentityFromGitFacts({
      commonDir: ".git",
      commonDirMetadata: {
        ...BASE_METADATA,
        birthtimeNs: BASE_METADATA.birthtimeNs + 1n,
      },
      originUrl: "https://github.com/example/project.git",
      projectRoot: "fixture/repo",
      rootCommit: "0123456789abcdef",
    });

    expect(original.id).toBe(recreated.id);
    expect(original.kind).toBe("remote");
    expect(original.stability).toBe("portable");
    expect(
      original.aliases.find((alias) => alias.kind === "git-common-dir")?.id
    ).not.toBe(
      recreated.aliases.find((alias) => alias.kind === "git-common-dir")?.id
    );
  });

  it("preserves identity-bearing SSH usernames without retaining credentials", () => {
    expect(normalizeRepositoryRemote("git@example.com:org/repo.git")).toBe(
      "example.com/org/repo"
    );
    expect(
      normalizeRepositoryRemote("ssh://alice:secret@example.com/org/repo.git")
    ).toBe("alice@example.com/org/repo");
    expect(
      normalizeRepositoryRemote("ssh://%61lice@example.com/org/repo.git")
    ).toBe("alice@example.com/org/repo");
    expect(
      normalizeRepositoryRemote("ssh://g%69t@example.com/org/repo.git")
    ).toBe("example.com/org/repo");
    expect(normalizeRepositoryRemote("%61lice@example.com:org/repo.git")).toBe(
      "%2561lice@example.com/org/repo"
    );
    expect(normalizeRepositoryRemote("foo#bar@example.com:org/repo.git")).toBe(
      "foo%23bar@example.com/org/repo"
    );
    expect(normalizeRepositoryRemote("foo?bar@example.com:org/repo.git")).toBe(
      "foo%3Fbar@example.com/org/repo"
    );
    expect(normalizeRepositoryRemote("foo:bar@example.com:org/repo.git")).toBe(
      "foo%3Abar@example.com/org/repo"
    );
    expect(
      normalizeRepositoryRemote("foo#bar@example.com:org/repo.git")
    ).not.toBe(
      normalizeRepositoryRemote("foo#baz@other.example:other/repo.git")
    );
    expect(
      normalizeRepositoryRemote("%40ops@example.com:org/repo.git")
    ).not.toBe(
      normalizeRepositoryRemote("ssh://%40ops@example.com/org/repo.git")
    );
    expect(
      normalizeRepositoryRemote("ssh://alice%40ops@example.com/org/repo.git")
    ).toBe("alice%40ops@example.com/org/repo");
    expect(
      normalizeRepositoryRemote("ssh://alice%2Fops@example.com/org/repo.git")
    ).toBe("alice%2Fops@example.com/org/repo");
    expect(
      normalizeRepositoryRemote("ssh://alice%0Aops@example.com/org/repo.git")
    ).toBe("alice%0Aops@example.com/org/repo");
    expect(
      normalizeRepositoryRemote("https://alice:secret@example.com/org/repo.git")
    ).toBe("example.com/org/repo");

    const alice = repositoryIdentityFromGitFacts({
      commonDir: ".git",
      commonDirMetadata: BASE_METADATA,
      originUrl: "ssh://alice@example.com/org/repo.git",
      projectRoot: "fixture/alice",
      rootCommit: "0123456789abcdef",
    });
    const bob = repositoryIdentityFromGitFacts({
      commonDir: ".git",
      commonDirMetadata: {
        ...BASE_METADATA,
        ino: BASE_METADATA.ino + 1n,
      },
      originUrl: "ssh://bob@example.com/org/repo.git",
      projectRoot: "fixture/bob",
      rootCommit: "0123456789abcdef",
    });

    expect(alice.fingerprint).toBe("alice@example.com/org/repo");
    expect(bob.fingerprint).toBe("bob@example.com/org/repo");
    expect(alice.id).not.toBe(bob.id);
  });
});
