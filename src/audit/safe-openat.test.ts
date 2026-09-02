import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditReportPersistenceSupported,
  darwinDirectoryStreamSymbols,
  linuxLibcCandidates,
  readDirectoryEntriesAt,
  replaceVerifiedFileAt,
  resolveLinuxLibcPath,
  unlinkVerifiedFileAt,
} from "./safe-openat";

test("Darwin directory reads select the SDK inode ABI for each architecture", () => {
  expect(darwinDirectoryStreamSymbols("x64")).toEqual({
    fdopendir: "fdopendir$INODE64",
    readdir: "readdir$INODE64",
  });
  expect(darwinDirectoryStreamSymbols("arm64")).toEqual({
    fdopendir: "fdopendir",
    readdir: "readdir",
  });
});

test("Linux libc candidates cover Bun-supported glibc and musl runtimes", () => {
  expect(linuxLibcCandidates("x64")).toEqual([
    "libc.so.6",
    "/lib/libc.musl-x86_64.so.1",
    "/lib/ld-musl-x86_64.so.1",
  ]);
  expect(linuxLibcCandidates("arm64")).toEqual([
    "libc.so.6",
    "/lib/libc.musl-aarch64.so.1",
    "/lib/ld-musl-aarch64.so.1",
  ]);
  expect(linuxLibcCandidates("unsupported-architecture")).toEqual([
    "libc.so.6",
  ]);
});

test("Linux libc resolution falls back deterministically and closes probes", () => {
  const attempts: string[] = [];
  const closes: string[] = [];
  const selected = resolveLinuxLibcPath({
    architecture: "arm64",
    openProbe: (library) => {
      attempts.push(library);
      if (library === "libc.so.6") {
        throw new Error("unavailable glibc detail must not escape");
      }
      return {
        close: () => {
          closes.push(library);
        },
      };
    },
  });

  expect(selected).toBe("/lib/libc.musl-aarch64.so.1");
  expect(attempts).toEqual(["libc.so.6", "/lib/libc.musl-aarch64.so.1"]);
  expect(closes).toEqual(["/lib/libc.musl-aarch64.so.1"]);
});

test("Linux libc probes require the complete report-writer symbol contract", () => {
  const closes: string[] = [];
  const selected = resolveLinuxLibcPath({
    architecture: "arm64",
    openProbe: (library, symbols) => {
      if (!("linkat" in symbols)) {
        throw new Error("linkat is unavailable");
      }
      return {
        close: () => {
          closes.push(library);
        },
      };
    },
  });

  expect(selected).toBe("libc.so.6");
  expect(closes).toEqual(["libc.so.6"]);
});

test("Linux libc resolution rejects failed probes without leaking loader details", () => {
  const attempts: string[] = [];
  const closed: string[] = [];
  expect(() =>
    resolveLinuxLibcPath({
      architecture: "x64",
      openProbe: (library) => {
        attempts.push(library);
        if (library === "/lib/libc.musl-x86_64.so.1") {
          return {
            close: () => {
              closed.push(library);
              throw new Error("unsafe probe close detail");
            },
          };
        }
        throw new Error("host loader detail");
      },
    })
  ).toThrow("System libc FFI is unsupported on linux/x64");
  expect(attempts).toEqual(["libc.so.6", "/lib/libc.musl-x86_64.so.1"]);
  expect(closed).toEqual(["/lib/libc.musl-x86_64.so.1"]);
});

test("Linux libc resolution fails closed when every candidate is unavailable", () => {
  const attempts: string[] = [];
  expect(() =>
    resolveLinuxLibcPath({
      architecture: "x64",
      openProbe: (library) => {
        attempts.push(library);
        throw new Error(`private loader detail for ${library}`);
      },
    })
  ).toThrow("System libc FFI is unsupported on linux/x64");
  expect(attempts).toEqual([...linuxLibcCandidates("x64")]);
});

test("runtime libc resolves and descriptor-bound directory reads work", async () => {
  if (!(process.platform === "darwin" || process.platform === "linux")) {
    expect(auditReportPersistenceSupported()).toBe(false);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "fclt-safe-openat-runtime-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "entry.txt"), "entry\n");
  const directoryFd = openSync(
    root,
    constants.O_RDONLY + (constants.O_DIRECTORY ?? 0)
  );
  try {
    expect(
      readDirectoryEntriesAt({ directoryFd, maxEntries: 8 }).map((entry) => ({
        directory: entry.isDirectory(),
        file: entry.isFile(),
        name: entry.name,
      }))
    ).toEqual([
      { directory: false, file: true, name: "entry.txt" },
      { directory: true, file: false, name: "nested" },
    ]);
    expect(auditReportPersistenceSupported()).toBe(true);
  } finally {
    closeSync(directoryFd);
    await rm(root, { force: true, recursive: true });
  }
});

test("verified replacement compensates an existing target swapped at the exchange boundary", async () => {
  if (!(process.platform === "darwin" || process.platform === "linux")) {
    return;
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-safe-replace-runtime-"))
  );
  const target = join(root, "entry.txt");
  const displaced = join(root, "entry.reviewed.txt");
  const reviewed = "reviewed\n";
  const concurrent = "concurrent\n";
  await writeFile(target, reviewed);
  await chmod(target, 0o640);
  const identity = await lstat(target);
  try {
    await expect(
      replaceVerifiedFileAt({
        beforeExchange: async () => {
          await rename(target, displaced);
          await writeFile(target, concurrent);
        },
        contents: "replacement\n",
        directoryPath: root,
        expected: {
          contents: reviewed,
          identity: { dev: identity.dev, ino: identity.ino },
          mode: 0o640,
        },
        fileName: "entry.txt",
        maxBytes: 1024,
        mode: 0o640,
      })
    ).rejects.toThrow("conditional commit boundary");

    expect(await readFile(target, "utf8")).toBe(concurrent);
    expect(await readFile(displaced, "utf8")).toBe(reviewed);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verified replacement uses no-replace creation when an absent target races", async () => {
  if (!(process.platform === "darwin" || process.platform === "linux")) {
    return;
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-safe-create-runtime-"))
  );
  const target = join(root, "entry.txt");
  try {
    await expect(
      replaceVerifiedFileAt({
        beforeExchange: async () => {
          await writeFile(target, "concurrent\n");
        },
        contents: "replacement\n",
        directoryPath: root,
        expected: null,
        fileName: "entry.txt",
        maxBytes: 1024,
        mode: 0o644,
      })
    ).rejects.toThrow("no-replace commit boundary");

    expect(await readFile(target, "utf8")).toBe("concurrent\n");
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verified replacement rejects a rebound parent before exchange", async () => {
  if (!(process.platform === "darwin" || process.platform === "linux")) {
    return;
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-safe-replace-parent-"))
  );
  const directory = join(root, ".ai");
  const displacedDirectory = join(root, ".ai-reviewed");
  const target = join(directory, "entry.txt");
  await mkdir(directory);
  await writeFile(target, "reviewed\n");
  try {
    await expect(
      replaceVerifiedFileAt({
        beforeExchange: async () => {
          await rename(directory, displacedDirectory);
          await mkdir(directory);
          await writeFile(target, "concurrent\n");
        },
        contents: "replacement\n",
        directoryPath: directory,
        expected: { contents: "reviewed\n", mode: 0o644 },
        fileName: "entry.txt",
        maxBytes: 1024,
        mode: 0o644,
        safeRoot: root,
      })
    ).rejects.toThrow("directory changed before conditional replace");

    expect(await readFile(target, "utf8")).toBe("concurrent\n");
    expect(await readFile(join(displacedDirectory, "entry.txt"), "utf8")).toBe(
      "reviewed\n"
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Windows verified replacement fails closed without an equivalent conditional commit", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-safe-replace-windows-"))
  );
  const target = join(root, "entry.txt");
  try {
    await expect(
      replaceVerifiedFileAt({
        contents: "replacement\n",
        directoryPath: root,
        expected: null,
        fileName: "entry.txt",
        maxBytes: 1024,
        mode: 0o644,
        platform: "win32",
      })
    ).rejects.toThrow("unsupported on win32");
    expect(await Bun.file(target).exists()).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verified unlink detects reappearance and restores the expected canonical file", async () => {
  if (!(process.platform === "darwin" || process.platform === "linux")) {
    return;
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-safe-unlink-runtime-"))
  );
  const target = join(root, "entry.txt");
  const expected = "expected\n";
  await writeFile(target, expected);
  try {
    await expect(
      unlinkVerifiedFileAt({
        afterQuarantine: async () => {
          await writeFile(target, "reappeared\n");
        },
        directoryPath: root,
        expectedSha256: createHash("sha256").update(expected).digest("hex"),
        fileName: "entry.txt",
        maxBytes: 1024,
      })
    ).rejects.toThrow("target reappeared");

    expect(await readFile(target, "utf8")).toBe(expected);
    const quarantines = (await readdir(root)).filter((name) =>
      name.endsWith(".rollback")
    );
    expect(quarantines).toHaveLength(1);
    expect(await readFile(join(root, quarantines[0] ?? ""), "utf8")).toBe(
      "reappeared\n"
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Windows verified unlink preserves a canonical leaf swapped before quarantine", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-safe-unlink-windows-"))
  );
  const target = join(root, "entry.txt");
  const displaced = join(root, "entry.original.txt");
  const expected = "expected\n";
  const replacement = "replacement\n";
  await writeFile(target, expected);
  try {
    await expect(
      unlinkVerifiedFileAt({
        beforeCommit: async () => {
          await rename(target, displaced);
          await writeFile(target, replacement);
        },
        directoryPath: root,
        expectedSha256: createHash("sha256").update(expected).digest("hex"),
        fileName: "entry.txt",
        maxBytes: 1024,
        platform: "win32",
      })
    ).rejects.toThrow("target changed at quarantine boundary");

    expect(await readFile(target, "utf8")).toBe(replacement);
    expect(await readFile(displaced, "utf8")).toBe(expected);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".rollback"))
    ).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Windows verified unlink compensates canonical reappearance without deleting it", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-safe-unlink-windows-reappear-"))
  );
  const target = join(root, "entry.txt");
  const expected = "expected\n";
  const reappeared = "reappeared\n";
  await writeFile(target, expected);
  try {
    await expect(
      unlinkVerifiedFileAt({
        afterQuarantine: async () => {
          await writeFile(target, reappeared);
        },
        directoryPath: root,
        expectedSha256: createHash("sha256").update(expected).digest("hex"),
        fileName: "entry.txt",
        maxBytes: 1024,
        platform: "win32",
      })
    ).rejects.toThrow("target reappeared");

    expect(await readFile(target, "utf8")).toBe(expected);
    const entries = await readdir(root);
    expect(entries.filter((name) => name.endsWith(".rollback"))).toEqual([]);
    const preserved = entries.filter((name) => name.endsWith(".preserved"));
    expect(preserved).toHaveLength(1);
    expect(await readFile(join(root, preserved[0] ?? ""), "utf8")).toBe(
      reappeared
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
