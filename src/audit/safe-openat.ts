import {
  dlopen,
  type FFIFunction,
  FFIType,
  type Library,
  type Pointer,
  ptr,
  toArrayBuffer,
} from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

const DIRECTORY_ENTRY_TYPES = {
  blockDevice: 6,
  characterDevice: 2,
  directory: 4,
  fifo: 1,
  file: 8,
  socket: 12,
  symlink: 10,
} as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LINUX_MUSL_LIBRARIES: Readonly<Record<string, readonly string[]>> = {
  arm64: ["/lib/libc.musl-aarch64.so.1", "/lib/ld-musl-aarch64.so.1"],
  x64: ["/lib/libc.musl-x86_64.so.1", "/lib/ld-musl-x86_64.so.1"],
};
const COMMON_SYSTEM_LIBC_PROBE_SYMBOLS = {
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  dup: { args: [FFIType.i32], returns: FFIType.i32 },
  fchmod: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fsync: { args: [FFIType.i32], returns: FFIType.i32 },
  linkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  mkdirat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  read: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  renameat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  rewinddir: { args: [FFIType.ptr], returns: FFIType.void },
  unlinkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  write: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
} as const;
const LINUX_SYSTEM_LIBC_PROBE_SYMBOLS = {
  ...COMMON_SYSTEM_LIBC_PROBE_SYMBOLS,
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;
const DARWIN_SYSTEM_LIBC_PROBE_SYMBOLS = {
  ...COMMON_SYSTEM_LIBC_PROBE_SYMBOLS,
  __error: { args: [], returns: FFIType.ptr },
} as const;

interface LibcProbeHandle {
  close: () => void;
}

let cachedLinuxLibcPath: string | null | undefined;
let cachedRuntimeSystemLibcSupport: boolean | undefined;

export function linuxLibcCandidates(
  architecture: string = process.arch
): readonly string[] {
  return ["libc.so.6", ...(LINUX_MUSL_LIBRARIES[architecture] ?? [])];
}

export function resolveLinuxLibcPath(options?: {
  architecture?: string;
  openProbe?: (
    library: string,
    symbols: typeof LINUX_SYSTEM_LIBC_PROBE_SYMBOLS
  ) => LibcProbeHandle;
}): string {
  if (!options && cachedLinuxLibcPath !== undefined) {
    if (cachedLinuxLibcPath === null) {
      throw new Error(
        `System libc FFI is unsupported on linux/${process.arch}`
      );
    }
    return cachedLinuxLibcPath;
  }
  const architecture = options?.architecture ?? process.arch;
  const openProbe =
    options?.openProbe ??
    ((library: string) => dlopen(library, LINUX_SYSTEM_LIBC_PROBE_SYMBOLS));
  for (const candidate of linuxLibcCandidates(architecture)) {
    let probe: LibcProbeHandle;
    try {
      probe = openProbe(candidate, LINUX_SYSTEM_LIBC_PROBE_SYMBOLS);
    } catch {
      // Try the next reviewed libc candidate and fail closed if none load.
      continue;
    }
    try {
      probe.close();
    } catch {
      if (!options) {
        cachedLinuxLibcPath = null;
      }
      throw new Error(
        `System libc FFI is unsupported on linux/${architecture}`
      );
    }
    if (!options) {
      cachedLinuxLibcPath = candidate;
    }
    return candidate;
  }
  if (!options) {
    cachedLinuxLibcPath = null;
  }
  throw new Error(`System libc FFI is unsupported on linux/${architecture}`);
}

interface SystemLibcConfiguration {
  createExclusive: number;
  library: string;
}

function platformConfiguration(): SystemLibcConfiguration {
  if (process.platform === "darwin") {
    return {
      createExclusive: 0xa_01,
      library: "/usr/lib/libSystem.B.dylib",
    };
  }
  if (process.platform === "linux") {
    return {
      createExclusive: 0xc1,
      library: resolveLinuxLibcPath(),
    };
  }
  throw new Error(
    `System libc FFI is unsupported on ${process.platform}/${process.arch}`
  );
}

function openSystemLibc<Fns extends Record<string, FFIFunction>>(
  configuration: SystemLibcConfiguration,
  symbols: Fns
): Library<Fns> {
  try {
    return dlopen(configuration.library, symbols);
  } catch {
    throw new Error(
      `System libc FFI is unsupported on ${process.platform}/${process.arch}`
    );
  }
}

function directoryEntry(args: { name: string; type: number }): Dirent {
  const isType = (type: number): boolean => args.type === type;
  return {
    isBlockDevice: () => isType(DIRECTORY_ENTRY_TYPES.blockDevice),
    isCharacterDevice: () => isType(DIRECTORY_ENTRY_TYPES.characterDevice),
    isDirectory: () => isType(DIRECTORY_ENTRY_TYPES.directory),
    isFIFO: () => isType(DIRECTORY_ENTRY_TYPES.fifo),
    isFile: () => isType(DIRECTORY_ENTRY_TYPES.file),
    isSocket: () => isType(DIRECTORY_ENTRY_TYPES.socket),
    isSymbolicLink: () => isType(DIRECTORY_ENTRY_TYPES.symlink),
    name: args.name,
    parentPath: "",
  };
}

interface DirectoryStreamLibrary {
  close: () => void;
  closeFileDescriptor: (fileDescriptor: number) => number;
  closedir: (directory: Pointer) => number;
  dup: (fileDescriptor: number) => number;
  errnoPointer: () => Pointer;
  fdopendir: (fileDescriptor: number) => Pointer | null;
  readdir: (directory: Pointer) => Pointer | null;
  rewinddir: (directory: Pointer) => void;
}

interface DirectoryStreamSymbols {
  __errno_location?: () => Pointer;
  __error?: () => Pointer;
  close: (fd: number) => number;
  closedir: (directory: Pointer) => number;
  dup: (fd: number) => number;
  fdopendir?: (fd: number) => Pointer;
  fdopendir$INODE64?: (fd: number) => Pointer;
  readdir?: (directory: Pointer) => Pointer;
  readdir$INODE64?: (directory: Pointer) => Pointer;
  rewinddir: (directory: Pointer) => void;
}

interface PrivateFileSnapshot {
  contents: string;
  metadata: Stats;
}

interface DirectoryMutationSymbols {
  __errno_location?: () => Pointer;
  __error?: () => Pointer;
  close: (fd: number) => number;
  mkdirat: (directoryFd: number, name: Pointer, mode: number) => number;
  openat: (
    directoryFd: number,
    name: Pointer,
    flags: number,
    mode: number
  ) => number;
}

interface PrivateFileMutationSymbols extends DirectoryMutationSymbols {
  fchmod: (fd: number, mode: number) => number;
  flock: (fd: number, operation: number) => number;
  fsync: (fd: number) => number;
  linkat: (
    oldDirectoryFd: number,
    oldName: Pointer,
    newDirectoryFd: number,
    newName: Pointer,
    flags: number
  ) => number;
  read: (fd: number, buffer: Pointer, length: number) => number | bigint;
  renameat: (
    oldDirectoryFd: number,
    oldName: Pointer,
    newDirectoryFd: number,
    newName: Pointer
  ) => number;
  renameat2?: (
    oldDirectoryFd: number,
    oldName: Pointer,
    newDirectoryFd: number,
    newName: Pointer,
    flags: number
  ) => number;
  renameatx_np?: (
    oldDirectoryFd: number,
    oldName: Pointer,
    newDirectoryFd: number,
    newName: Pointer,
    flags: number
  ) => number;
  unlinkat: (directoryFd: number, name: Pointer, flags: number) => number;
  write: (fd: number, buffer: Pointer, length: number) => number | bigint;
}

export function darwinDirectoryStreamSymbols(
  architecture: string = process.arch
): {
  fdopendir: "fdopendir" | "fdopendir$INODE64";
  readdir: "readdir" | "readdir$INODE64";
} {
  // Intel macOS still exports legacy 32-bit-inode directory-stream ABIs.
  // Native callers are redirected to the modern dirent layout by the SDK
  // aliases, which FFI must select explicitly as a pair. Apple Silicon only
  // exposes the modern ABI under the unsuffixed symbols.
  return architecture === "x64"
    ? {
        fdopendir: "fdopendir$INODE64",
        readdir: "readdir$INODE64",
      }
    : { fdopendir: "fdopendir", readdir: "readdir" };
}

function directoryStreamLibrary(): DirectoryStreamLibrary {
  const configuration = platformConfiguration();
  const definitions: Record<string, FFIFunction> = {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    rewinddir: { args: [FFIType.ptr], returns: FFIType.void },
  };
  if (process.platform === "darwin") {
    const directorySymbols = darwinDirectoryStreamSymbols();
    definitions[directorySymbols.fdopendir] = {
      args: [FFIType.i32],
      returns: FFIType.ptr,
    };
    definitions[directorySymbols.readdir] = {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    };
    definitions.__error = { args: [], returns: FFIType.ptr };
    const libc = openSystemLibc(configuration, definitions);
    const symbols = libc.symbols as unknown as DirectoryStreamSymbols;
    return {
      close: () => libc.close(),
      closeFileDescriptor: (fileDescriptor) => symbols.close(fileDescriptor),
      closedir: (directory) => symbols.closedir(directory),
      dup: (fileDescriptor) => symbols.dup(fileDescriptor),
      errnoPointer: () => symbols.__error!(),
      fdopendir: (fileDescriptor) =>
        symbols[directorySymbols.fdopendir]!(fileDescriptor),
      readdir: (directory) => symbols[directorySymbols.readdir]!(directory),
      rewinddir: (directory) => symbols.rewinddir(directory),
    };
  }
  if (process.platform === "linux") {
    definitions.fdopendir = { args: [FFIType.i32], returns: FFIType.ptr };
    definitions.readdir = { args: [FFIType.ptr], returns: FFIType.ptr };
    definitions.__errno_location = { args: [], returns: FFIType.ptr };
    const libc = openSystemLibc(configuration, definitions);
    const symbols = libc.symbols as unknown as DirectoryStreamSymbols;
    return {
      close: () => libc.close(),
      closeFileDescriptor: (fileDescriptor) => symbols.close(fileDescriptor),
      closedir: (directory) => symbols.closedir(directory),
      dup: (fileDescriptor) => symbols.dup(fileDescriptor),
      errnoPointer: () => symbols.__errno_location!(),
      fdopendir: (fileDescriptor) => symbols.fdopendir!(fileDescriptor),
      readdir: (directory) => symbols.readdir!(directory),
      rewinddir: (directory) => symbols.rewinddir(directory),
    };
  }
  throw new Error(
    `Descriptor-bound directory enumeration is unavailable on ${process.platform}`
  );
}

function directoryEntryLayout(): {
  nameLengthOffset: number | null;
  nameOffset: number;
  recordLengthOffset: number;
  typeOffset: number;
} {
  return process.platform === "darwin"
    ? {
        nameLengthOffset: 18,
        nameOffset: 21,
        recordLengthOffset: 16,
        typeOffset: 20,
      }
    : {
        nameLengthOffset: null,
        nameOffset: 19,
        recordLengthOffset: 16,
        typeOffset: 18,
      };
}

export function readDirectoryEntriesAt(args: {
  directoryFd: number;
  maxEntries: number;
}): Dirent[] {
  const libc = directoryStreamLibrary();
  const duplicatedFd = libc.dup(args.directoryFd);
  if (duplicatedFd < 0) {
    libc.close();
    throw new Error("Descriptor-bound directory duplication failed closed");
  }
  const directory = libc.fdopendir(duplicatedFd);
  if (!directory) {
    libc.closeFileDescriptor(duplicatedFd);
    libc.close();
    throw new Error("Descriptor-bound directory open failed closed");
  }
  const errno = new DataView(toArrayBuffer(libc.errnoPointer(), 0, 4));
  const layout = directoryEntryLayout();
  const entries: Dirent[] = [];
  let failure: unknown;
  let closeResult = 0;
  try {
    while (true) {
      errno.setInt32(0, 0, true);
      const entryPointer = libc.readdir(directory);
      if (!entryPointer) {
        if (errno.getInt32(0, true) !== 0) {
          throw new Error("Descriptor-bound directory read failed closed");
        }
        break;
      }
      const header = new DataView(
        toArrayBuffer(entryPointer, 0, layout.nameOffset)
      );
      const recordLength = header.getUint16(layout.recordLengthOffset, true);
      const maxNameLength = recordLength - layout.nameOffset;
      const nameLength =
        layout.nameLengthOffset === null
          ? maxNameLength
          : header.getUint16(layout.nameLengthOffset, true);
      if (
        recordLength <= layout.nameOffset ||
        nameLength <= 0 ||
        nameLength > maxNameLength
      ) {
        throw new Error("Descriptor-bound directory entry is malformed");
      }
      const nameBytes = new Uint8Array(
        toArrayBuffer(entryPointer, layout.nameOffset, nameLength)
      );
      const terminatorIndex = nameBytes.indexOf(0);
      const exactNameBytes =
        terminatorIndex < 0
          ? nameBytes
          : nameBytes.subarray(0, terminatorIndex);
      if (exactNameBytes.length === 0) {
        throw new Error("Descriptor-bound directory entry has an empty name");
      }
      let name: string;
      try {
        name = UTF8_DECODER.decode(exactNameBytes);
      } catch {
        throw new Error("Descriptor-bound directory entry name is not UTF-8");
      }
      if (name === "." || name === "..") {
        continue;
      }
      if (entries.length >= args.maxEntries) {
        throw new Error("Audit discovery tree exceeds entry limit");
      }
      entries.push(
        directoryEntry({
          name,
          type: header.getUint8(layout.typeOffset),
        })
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    libc.rewinddir(directory);
    closeResult = libc.closedir(directory);
    libc.close();
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (closeResult !== 0) {
    throw new Error("Descriptor-bound directory close failed closed");
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
}

function permissionBits(mode: number): number {
  return mode % 0o1000;
}

function groupOrOtherWritable(mode: number): boolean {
  const permissions = permissionBits(mode);
  const group = Math.floor(permissions / 8) % 8;
  const other = permissions % 8;
  return Math.floor(group / 2) % 2 === 1 || Math.floor(other / 2) % 2 === 1;
}

export function auditReportPersistenceSupported(
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!(platform === "darwin" || platform === "linux")) {
    return false;
  }
  if (platform !== process.platform) {
    return true;
  }
  if (cachedRuntimeSystemLibcSupport !== undefined) {
    return cachedRuntimeSystemLibcSupport;
  }
  try {
    const configuration = platformConfiguration();
    const probe = openSystemLibc(
      configuration,
      process.platform === "darwin"
        ? DARWIN_SYSTEM_LIBC_PROBE_SYMBOLS
        : LINUX_SYSTEM_LIBC_PROBE_SYMBOLS
    );
    probe.close();
    cachedRuntimeSystemLibcSupport = true;
    return true;
  } catch {
    cachedRuntimeSystemLibcSupport = false;
    return false;
  }
}

export function openReadOnlyAt(args: {
  directoryFd: number;
  fileName: string;
}): number {
  if (args.fileName.includes("/") || args.fileName.includes("\\")) {
    throw new Error(
      "Descriptor-relative report names must be single path segments"
    );
  }
  const configuration = platformConfiguration();
  const libc = openSystemLibc(configuration, {
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  try {
    const fd = libc.symbols.openat(
      args.directoryFd,
      ptr(Buffer.from(`${args.fileName}\0`)),
      safeExistingOpenFlags(),
      0
    );
    if (fd < 0) {
      throw new Error(
        `Descriptor-relative report open failed closed: ${args.fileName}`
      );
    }
    return fd;
  } finally {
    libc.close();
  }
}

export function writeExclusiveAt(args: {
  contents: string;
  directoryFd: number;
  fileName: string;
}): void {
  if (args.fileName.includes("/") || args.fileName.includes("\\")) {
    throw new Error(
      "Descriptor-relative report names must be single path segments"
    );
  }
  const configuration = platformConfiguration();
  const libc = openSystemLibc(configuration, {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    fchmod: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    fsync: { args: [FFIType.i32], returns: FFIType.i32 },
    linkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    read: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    unlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    write: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  });
  const verifyExisting = (): void => {
    const expected = Buffer.from(args.contents);
    const existingFd = libc.symbols.openat(
      args.directoryFd,
      ptr(Buffer.from(`${args.fileName}\0`)),
      safeExistingOpenFlags(),
      0
    );
    if (existingFd < 0) {
      throw new Error(
        `Descriptor-relative report commit failed closed: ${args.fileName}`
      );
    }
    try {
      let before = fstatSync(existingFd);
      for (let attempt = 0; before.nlink > 1 && attempt < 50; attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        before = fstatSync(existingFd);
      }
      const expectedOwner = process.getuid?.();
      if (
        !before.isFile() ||
        before.size !== expected.byteLength ||
        before.nlink !== 1 ||
        permissionBits(before.mode) !== 0o600 ||
        (expectedOwner !== undefined && before.uid !== expectedOwner)
      ) {
        throw new Error(
          `Audit report content-address collision: ${args.fileName}`
        );
      }
      let readOffset = 0;
      while (readOffset < expected.byteLength) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, expected.byteLength - readOffset)
        );
        const count = Number(
          libc.symbols.read(existingFd, ptr(chunk), chunk.byteLength)
        );
        if (count <= 0) {
          throw new Error(`Could not verify existing report: ${args.fileName}`);
        }
        if (
          !chunk
            .subarray(0, count)
            .equals(expected.subarray(readOffset, readOffset + count))
        ) {
          throw new Error(
            `Audit report content-address collision: ${args.fileName}`
          );
        }
        readOffset += count;
      }
      const trailing = Buffer.allocUnsafe(1);
      if (Number(libc.symbols.read(existingFd, ptr(trailing), 1)) !== 0) {
        throw new Error(
          `Audit report content-address collision: ${args.fileName}`
        );
      }
      const after = fstatSync(existingFd);
      if (
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.nlink !== 1 ||
        permissionBits(after.mode) !== 0o600 ||
        (expectedOwner !== undefined && after.uid !== expectedOwner)
      ) {
        throw new Error(
          `Descriptor-relative report identity changed: ${args.fileName}`
        );
      }
    } finally {
      libc.symbols.close(existingFd);
    }
  };
  const finalName = Buffer.from(`${args.fileName}\0`);
  const temporaryName = Buffer.from(`.${args.fileName}.${randomUUID()}.tmp\0`);
  let fd = libc.symbols.openat(
    args.directoryFd,
    ptr(temporaryName),
    configuration.createExclusive,
    0o600
  );
  try {
    if (fd < 0 || libc.symbols.fchmod(fd, 0o600) !== 0) {
      throw new Error(
        `Descriptor-relative temporary report creation failed closed: ${args.fileName}`
      );
    }
    const bytes = Buffer.from(args.contents);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Number(
        libc.symbols.write(fd, ptr(bytes, offset), bytes.length - offset)
      );
      if (count <= 0) {
        throw new Error(`Could not write audit report: ${args.fileName}`);
      }
      offset += count;
    }
    if (libc.symbols.fsync(fd) !== 0) {
      throw new Error(`Could not sync audit report: ${args.fileName}`);
    }
    const temporaryMetadata = fstatSync(fd);
    const expectedOwner = process.getuid?.();
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.nlink !== 1 ||
      permissionBits(temporaryMetadata.mode) !== 0o600 ||
      (expectedOwner !== undefined && temporaryMetadata.uid !== expectedOwner)
    ) {
      throw new Error(
        `Descriptor-relative temporary report is not regular: ${args.fileName}`
      );
    }
    libc.symbols.close(fd);
    fd = -1;

    const linked = libc.symbols.linkat(
      args.directoryFd,
      ptr(temporaryName),
      args.directoryFd,
      ptr(finalName),
      0
    );
    if (linked === 0) {
      return;
    }
    verifyExisting();
  } finally {
    if (fd >= 0) {
      libc.symbols.close(fd);
    }
    libc.symbols.unlinkat(args.directoryFd, ptr(temporaryName), 0);
    libc.close();
  }
}

/** Hold a non-blocking process-scoped advisory lock until the returned release function runs. */
export function acquireExclusiveAdvisoryLock(
  fileDescriptor: number
): () => void {
  if (!auditReportPersistenceSupported()) {
    throw new Error(
      `Advisory file locking is unavailable on ${process.platform}`
    );
  }
  const libc = openSystemLibc(platformConfiguration(), {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  if (libc.symbols.flock(fileDescriptor, 6) !== 0) {
    libc.close();
    throw new Error("Another project render mutation is already running.");
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    libc.symbols.flock(fileDescriptor, 8);
    libc.close();
  };
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

function privateMutableFileIsSafe(metadata: Stats, maxBytes: number): boolean {
  const expectedOwner = process.getuid?.();
  return (
    metadata.isFile() &&
    metadata.nlink === 1 &&
    expectedOwner !== undefined &&
    metadata.uid === expectedOwner &&
    !groupOrOtherWritable(metadata.mode) &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size >= 0 &&
    metadata.size <= maxBytes
  );
}

function privateDirectoryComponentIsSafe(metadata: Stats): boolean {
  const expectedOwner = process.getuid?.();
  return (
    metadata.isDirectory() &&
    (metadata.uid === 0 || metadata.uid === expectedOwner) &&
    !groupOrOtherWritable(metadata.mode)
  );
}

export interface PrivateDirectoryReceiptBinding {
  ancestorDev: string;
  ancestorIno: string;
  ancestorPath: string;
  directorySegments: string[];
}

export interface PrivateDirectoryIdentity {
  dev: number;
  ino: number;
  mode: number;
}

export interface BoundPrivateSubdirectory {
  directoryFd: number;
  rootFd: number;
}

export function openBoundPrivateSubdirectory(args: {
  directoryIdentity: PrivateDirectoryIdentity;
  directoryName: string;
  rootIdentity: PrivateDirectoryIdentity;
  rootPath: string;
}): BoundPrivateSubdirectory {
  if (
    !isAbsolute(args.rootPath) ||
    normalize(args.rootPath) !== args.rootPath ||
    !args.directoryName ||
    args.directoryName === "." ||
    args.directoryName === ".." ||
    args.directoryName.includes(sep) ||
    !auditReportPersistenceSupported()
  ) {
    throw new Error("Bound private directory path is unsupported");
  }
  const configuration = platformConfiguration();
  const libc = openSystemLibc(configuration, {
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  const directoryFlags =
    constants.O_RDONLY +
    (constants.O_DIRECTORY ?? 0) +
    (constants.O_NOFOLLOW ?? 0) +
    (constants.O_NONBLOCK ?? 0) +
    ((constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0);
  let rootFd = -1;
  let directoryFd = -1;
  try {
    rootFd = openSync(args.rootPath, directoryFlags);
    const rootMetadata = fstatSync(rootFd);
    if (
      !privateDirectoryComponentIsSafe(rootMetadata) ||
      rootMetadata.dev !== args.rootIdentity.dev ||
      rootMetadata.ino !== args.rootIdentity.ino ||
      rootMetadata.mode !== args.rootIdentity.mode ||
      realpathSync(args.rootPath) !== args.rootPath
    ) {
      throw new Error("Bound private root changed before open");
    }
    directoryFd = libc.symbols.openat(
      rootFd,
      ptr(Buffer.from(`${args.directoryName}\0`)),
      directoryFlags,
      0
    );
    if (directoryFd < 0) {
      throw new Error("Bound private directory could not be opened");
    }
    const directoryMetadata = fstatSync(directoryFd);
    if (
      !privateDirectoryComponentIsSafe(directoryMetadata) ||
      directoryMetadata.dev !== args.directoryIdentity.dev ||
      directoryMetadata.ino !== args.directoryIdentity.ino ||
      directoryMetadata.mode !== args.directoryIdentity.mode
    ) {
      throw new Error("Bound private directory changed before open");
    }
    const result = { directoryFd, rootFd };
    directoryFd = -1;
    rootFd = -1;
    return result;
  } finally {
    if (directoryFd >= 0) {
      closeSync(directoryFd);
    }
    if (rootFd >= 0) {
      closeSync(rootFd);
    }
    libc.close();
  }
}

export function openOrCreatePrivateDirectory(
  binding: PrivateDirectoryReceiptBinding
): number {
  if (
    !isAbsolute(binding.ancestorPath) ||
    normalize(binding.ancestorPath) !== binding.ancestorPath ||
    binding.directorySegments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.includes(sep)
    ) ||
    !auditReportPersistenceSupported()
  ) {
    throw new Error("Private directory path must be canonical and supported");
  }
  const configuration = platformConfiguration();
  const definitions: Record<string, FFIFunction> = {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    mkdirat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  };
  const libc = openSystemLibc(configuration, definitions);
  const symbols = libc.symbols as unknown as DirectoryMutationSymbols;
  const directoryFlags =
    constants.O_RDONLY +
    (constants.O_DIRECTORY ?? 0) +
    (constants.O_NOFOLLOW ?? 0) +
    (constants.O_NONBLOCK ?? 0) +
    ((constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0);
  let currentFd = openSync(binding.ancestorPath, directoryFlags);
  try {
    const ancestorMetadata = fstatSync(currentFd);
    if (
      !privateDirectoryComponentIsSafe(ancestorMetadata) ||
      String(ancestorMetadata.dev) !== binding.ancestorDev ||
      String(ancestorMetadata.ino) !== binding.ancestorIno ||
      realpathSync(binding.ancestorPath) !== binding.ancestorPath
    ) {
      throw new Error("Private directory root is unsafe");
    }
    for (const segment of binding.directorySegments) {
      const name = Buffer.from(`${segment}\0`);
      let nextFd = symbols.openat(currentFd, ptr(name), directoryFlags, 0);
      if (nextFd < 0) {
        symbols.mkdirat(currentFd, ptr(name), 0o700);
        nextFd = symbols.openat(currentFd, ptr(name), directoryFlags, 0);
      }
      if (nextFd < 0) {
        throw new Error(`Could not open private directory: ${segment}`);
      }
      if (!privateDirectoryComponentIsSafe(fstatSync(nextFd))) {
        symbols.close(nextFd);
        throw new Error(`Private directory component is unsafe: ${segment}`);
      }
      closeSync(currentFd);
      currentFd = nextFd;
    }
    const descriptorMetadata = fstatSync(currentFd);
    const directoryPath = normalize(
      join(binding.ancestorPath, ...binding.directorySegments)
    );
    const pathMetadata = lstatSync(directoryPath);
    if (
      pathMetadata.isSymbolicLink() ||
      !privateDirectoryComponentIsSafe(pathMetadata) ||
      descriptorMetadata.dev !== pathMetadata.dev ||
      descriptorMetadata.ino !== pathMetadata.ino ||
      realpathSync(directoryPath) !== directoryPath
    ) {
      throw new Error("Private directory changed while it was opened");
    }
    const result = currentFd;
    currentFd = -1;
    return result;
  } finally {
    if (currentFd >= 0) {
      closeSync(currentFd);
    }
    libc.close();
  }
}

export interface PrivateFileReceiptIdentity {
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  sha256: string;
  size: number;
}

function sameReceiptFileIdentity(
  metadata: Stats,
  expected: PrivateFileReceiptIdentity
): boolean {
  return (
    privateMutableFileIsSafe(metadata, Math.max(expected.size, 0)) &&
    metadata.dev === expected.dev &&
    metadata.ino === expected.ino &&
    metadata.mode === expected.mode &&
    metadata.size === expected.size &&
    metadata.ctimeMs === expected.ctimeMs &&
    metadata.mtimeMs === expected.mtimeMs
  );
}

function sameObjectIdentity(left: Stats, right: Stats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid
  );
}

export async function replaceBoundPrivateFilePairAt(args: {
  assertCommitPolicy?: () => void;
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeSourceCommit?: () => Promise<void>;
  destinationIdentity: PrivateFileReceiptIdentity | null;
  destinationName: string;
  directoryFd: number;
  directoryIdentity: PrivateDirectoryIdentity;
  maxBytes: number;
  rootFd: number;
  rootIdentity: PrivateDirectoryIdentity;
  rootPath: string;
  sourceIdentity: PrivateFileReceiptIdentity;
  sourceName: string;
  transform: (
    sourceContents: string,
    destinationContents: string | null
  ) => { destinationContents: string; sourceContents: string };
}): Promise<{ destinationContents: string; sourceContents: string }> {
  for (const name of [args.sourceName, args.destinationName]) {
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      throw new Error("Bound private file names must be one segment");
    }
  }
  if (args.sourceName === args.destinationName) {
    throw new Error("Bound private source and destination must be distinct");
  }
  const configuration = platformConfiguration();
  const definitions: Record<string, FFIFunction> = {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    fchmod: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fsync: { args: [FFIType.i32], returns: FFIType.i32 },
    linkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    unlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    write: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  };
  if (process.platform === "darwin") {
    definitions.renameatx_np = {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    };
    definitions.__error = { args: [], returns: FFIType.ptr };
  } else {
    definitions.renameat2 = {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    };
    definitions.__errno_location = { args: [], returns: FFIType.ptr };
  }
  const libc = openSystemLibc(configuration, definitions);
  const symbols = libc.symbols as unknown as PrivateFileMutationSymbols;
  const errnoPointer =
    process.platform === "darwin"
      ? symbols.__error!()
      : symbols.__errno_location!();
  const errno = new DataView(toArrayBuffer(errnoPointer!, 0, 4));
  const sourceName = Buffer.from(`${args.sourceName}\0`);
  const destinationName = Buffer.from(`${args.destinationName}\0`);
  const sourceTemporaryName = Buffer.from(
    `.${args.sourceName}.${randomUUID()}.tmp\0`
  );
  const destinationTemporaryName = Buffer.from(
    `.${args.destinationName}.${randomUUID()}.tmp\0`
  );
  let sourceFd = -1;
  let destinationFd = -1;
  let sourceTemporaryFd = -1;
  let destinationTemporaryFd = -1;
  let destinationCommitted = false;
  let sourceCommitted = false;
  let sourceBefore: Stats | null = null;
  let destinationBefore: Stats | null = null;
  let sourceTemporaryMetadata: Stats | null = null;
  let destinationTemporaryMetadata: Stats | null = null;

  const exchange = (left: Buffer, right: Buffer): void => {
    const result =
      process.platform === "darwin"
        ? symbols.renameatx_np!(
            args.directoryFd,
            ptr(left),
            args.directoryFd,
            ptr(right),
            2
          )
        : symbols.renameat2!(
            args.directoryFd,
            ptr(left),
            args.directoryFd,
            ptr(right),
            2
          );
    if (result !== 0) {
      throw new Error("Atomic private file exchange failed closed");
    }
  };
  const openExisting = (name: Buffer): number | null => {
    errno.setInt32(0, 0, true);
    const fd = symbols.openat(
      args.directoryFd,
      ptr(name),
      safeExistingOpenFlags(),
      0
    );
    if (fd >= 0) {
      return fd;
    }
    if (errno.getInt32(0, true) === 2) {
      return null;
    }
    throw new Error("Bound private file open failed closed");
  };
  const assertMappedObject = (name: Buffer, expected: Stats): void => {
    const fd = openExisting(name);
    if (fd === null) {
      throw new Error("Bound private file mapping disappeared");
    }
    try {
      if (!sameObjectIdentity(fstatSync(fd), expected)) {
        throw new Error("Bound private file mapping changed");
      }
    } finally {
      symbols.close(fd);
    }
  };
  const assertAbsent = (name: Buffer): void => {
    const fd = openExisting(name);
    if (fd !== null) {
      symbols.close(fd);
      throw new Error("Bound private destination appeared");
    }
  };
  const unlinkIfMapped = (name: Buffer, expected: Stats | null): boolean => {
    if (!expected) {
      return false;
    }
    const fd = openExisting(name);
    if (fd === null) {
      return true;
    }
    let matches = false;
    try {
      matches = sameObjectIdentity(fstatSync(fd), expected);
    } finally {
      symbols.close(fd);
    }
    return matches && symbols.unlinkat(args.directoryFd, ptr(name), 0) === 0;
  };
  const readHeld = (
    fd: number,
    expected: PrivateFileReceiptIdentity,
    label: string
  ): { contents: string; metadata: Stats } => {
    const before = fstatSync(fd);
    if (!sameReceiptFileIdentity(before, expected)) {
      throw new Error(`${label} no longer matches its audit receipt`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) {
        throw new Error(`${label} changed while reading`);
      }
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameFileIdentity(before, after)) {
      throw new Error(`${label} changed while reading`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error(`${label} bytes no longer match their audit receipt`);
    }
    try {
      return { contents: UTF8_DECODER.decode(bytes), metadata: before };
    } catch {
      throw new Error(`${label} is not UTF-8`);
    }
  };
  const stage = (
    name: Buffer,
    bytes: Buffer,
    mode: number
  ): { fd: number; metadata: Stats } => {
    const fd = symbols.openat(
      args.directoryFd,
      ptr(name),
      configuration.createExclusive,
      mode
    );
    if (fd < 0 || symbols.fchmod(fd, mode) !== 0) {
      if (fd >= 0) {
        symbols.close(fd);
        symbols.unlinkat(args.directoryFd, ptr(name), 0);
      }
      throw new Error("Bound private temporary creation failed closed");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = Number(
        symbols.write(fd, ptr(bytes, offset), bytes.length - offset)
      );
      if (count <= 0) {
        symbols.close(fd);
        symbols.unlinkat(args.directoryFd, ptr(name), 0);
        throw new Error("Bound private temporary write failed closed");
      }
      offset += count;
    }
    if (symbols.fsync(fd) !== 0) {
      symbols.close(fd);
      symbols.unlinkat(args.directoryFd, ptr(name), 0);
      throw new Error("Bound private temporary sync failed closed");
    }
    const metadata = fstatSync(fd);
    if (
      !privateMutableFileIsSafe(metadata, args.maxBytes) ||
      permissionBits(metadata.mode) !== mode ||
      metadata.size !== bytes.length
    ) {
      symbols.close(fd);
      symbols.unlinkat(args.directoryFd, ptr(name), 0);
      throw new Error("Bound private temporary is unsafe");
    }
    return { fd, metadata };
  };
  const assertDirectoryBinding = (): void => {
    const root = fstatSync(args.rootFd);
    const directory = fstatSync(args.directoryFd);
    const rootPathMetadata = lstatSync(args.rootPath);
    const directoryPath = join(args.rootPath, "mcp");
    const directoryPathMetadata = lstatSync(directoryPath);
    if (
      !privateDirectoryComponentIsSafe(root) ||
      root.dev !== args.rootIdentity.dev ||
      root.ino !== args.rootIdentity.ino ||
      root.mode !== args.rootIdentity.mode ||
      !privateDirectoryComponentIsSafe(directory) ||
      directory.dev !== args.directoryIdentity.dev ||
      directory.ino !== args.directoryIdentity.ino ||
      directory.mode !== args.directoryIdentity.mode ||
      rootPathMetadata.isSymbolicLink() ||
      !sameObjectIdentity(rootPathMetadata, root) ||
      directoryPathMetadata.isSymbolicLink() ||
      !sameObjectIdentity(directoryPathMetadata, directory) ||
      realpathSync(args.rootPath) !== args.rootPath ||
      realpathSync(directoryPath) !== directoryPath
    ) {
      throw new Error("Bound private directory identity changed");
    }
    const reboundFd = symbols.openat(
      args.rootFd,
      ptr(Buffer.from("mcp\0")),
      constants.O_RDONLY +
        (constants.O_DIRECTORY ?? 0) +
        (constants.O_NOFOLLOW ?? 0) +
        (constants.O_NONBLOCK ?? 0),
      0
    );
    if (reboundFd < 0) {
      throw new Error("Bound private directory mapping changed");
    }
    try {
      if (!sameObjectIdentity(fstatSync(reboundFd), directory)) {
        throw new Error("Bound private directory mapping changed");
      }
    } finally {
      symbols.close(reboundFd);
    }
  };
  const rollback = (): void => {
    if (sourceCommitted) {
      assertMappedObject(sourceName, sourceTemporaryMetadata!);
      assertMappedObject(sourceTemporaryName, sourceBefore!);
      exchange(sourceTemporaryName, sourceName);
      sourceCommitted = false;
    }
    if (destinationCommitted) {
      if (destinationBefore) {
        assertMappedObject(destinationName, destinationTemporaryMetadata!);
        assertMappedObject(destinationTemporaryName, destinationBefore);
        exchange(destinationTemporaryName, destinationName);
      } else {
        assertMappedObject(destinationName, destinationTemporaryMetadata!);
        if (symbols.unlinkat(args.directoryFd, ptr(destinationName), 0) !== 0) {
          throw new Error("Bound private destination rollback failed closed");
        }
      }
      destinationCommitted = false;
    }
    symbols.fsync(args.directoryFd);
  };

  try {
    if (symbols.flock(args.directoryFd, 6) !== 0) {
      throw new Error("Bound private mutation is already active");
    }
    assertDirectoryBinding();
    sourceFd = openExisting(sourceName) ?? -1;
    if (sourceFd < 0) {
      throw new Error("Bound private source disappeared");
    }
    const sourceSnapshot = readHeld(
      sourceFd,
      args.sourceIdentity,
      "Bound private source"
    );
    sourceBefore = sourceSnapshot.metadata;
    destinationFd = openExisting(destinationName) ?? -1;
    let destinationContents: string | null = null;
    if (args.destinationIdentity) {
      if (destinationFd < 0) {
        throw new Error("Bound private destination disappeared");
      }
      const destinationSnapshot = readHeld(
        destinationFd,
        args.destinationIdentity,
        "Bound private destination"
      );
      destinationBefore = destinationSnapshot.metadata;
      destinationContents = destinationSnapshot.contents;
    } else if (destinationFd >= 0) {
      throw new Error("Bound private destination appeared");
    }

    const committedContents = args.transform(
      sourceSnapshot.contents,
      destinationContents
    );
    const sourceBytes = Buffer.from(committedContents.sourceContents);
    const destinationBytes = Buffer.from(committedContents.destinationContents);
    if (
      sourceBytes.byteLength > args.maxBytes ||
      destinationBytes.byteLength > args.maxBytes
    ) {
      throw new Error("Bound private file exceeds byte limit");
    }

    let staged = stage(
      sourceTemporaryName,
      sourceBytes,
      permissionBits(args.sourceIdentity.mode)
    );
    sourceTemporaryFd = staged.fd;
    sourceTemporaryMetadata = staged.metadata;
    staged = stage(destinationTemporaryName, destinationBytes, 0o600);
    destinationTemporaryFd = staged.fd;
    destinationTemporaryMetadata = staged.metadata;

    assertDirectoryBinding();
    if (!sameFileIdentity(sourceBefore, fstatSync(sourceFd))) {
      throw new Error("Bound private source changed before commit");
    }
    assertMappedObject(sourceName, sourceBefore);
    args.assertCommitPolicy?.();
    if (destinationBefore) {
      if (!sameFileIdentity(destinationBefore, fstatSync(destinationFd))) {
        throw new Error("Bound private destination changed before commit");
      }
      assertMappedObject(destinationName, destinationBefore);
      exchange(destinationTemporaryName, destinationName);
    } else {
      assertAbsent(destinationName);
      if (
        symbols.linkat(
          args.directoryFd,
          ptr(destinationTemporaryName),
          args.directoryFd,
          ptr(destinationName),
          0
        ) !== 0
      ) {
        throw new Error("Bound private destination create failed closed");
      }
    }
    destinationCommitted = true;

    if (args.beforeSourceCommit) {
      await args.beforeSourceCommit();
    }
    assertDirectoryBinding();
    if (!sameFileIdentity(sourceBefore, fstatSync(sourceFd))) {
      throw new Error("Bound private source changed before final commit");
    }
    assertMappedObject(sourceName, sourceBefore);
    assertMappedObject(destinationName, destinationTemporaryMetadata);
    args.assertCommitPolicy?.();
    exchange(sourceTemporaryName, sourceName);
    sourceCommitted = true;
    assertMappedObject(sourceName, sourceTemporaryMetadata);
    assertMappedObject(sourceTemporaryName, sourceBefore);

    // Both exchanges are now the irrevocable commit. Cleanup cannot be
    // reported as a failed transaction because either rollback object may
    // already have been unlinked; doing so would turn a committed mutation
    // into a false failure and invite an unsafe pathname retry.
    sourceCommitted = false;
    destinationCommitted = false;
    unlinkIfMapped(sourceTemporaryName, sourceBefore);
    unlinkIfMapped(
      destinationTemporaryName,
      destinationBefore ?? destinationTemporaryMetadata
    );
    symbols.fsync(args.directoryFd);
    return committedContents;
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new Error(
        `Bound private mutation rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    if (sourceFd >= 0) {
      symbols.close(sourceFd);
    }
    if (destinationFd >= 0) {
      symbols.close(destinationFd);
    }
    if (sourceTemporaryFd >= 0) {
      symbols.close(sourceTemporaryFd);
    }
    if (destinationTemporaryFd >= 0) {
      symbols.close(destinationTemporaryFd);
    }
    unlinkIfMapped(sourceTemporaryName, sourceTemporaryMetadata);
    unlinkIfMapped(destinationTemporaryName, destinationTemporaryMetadata);
    libc.close();
  }
}

export async function replacePrivateFileAt(args: {
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeCommit?: () => Promise<void>;
  directoryFd: number;
  expectedPriorSha256?: string | null;
  fileName: string;
  maxBytes: number;
  transform: (contents: string | null) => string;
}): Promise<{ contents: string; previousContents: string | null }> {
  if (
    args.fileName.includes("/") ||
    args.fileName.includes("\\") ||
    args.fileName === "." ||
    args.fileName === ".."
  ) {
    throw new Error(
      "Descriptor-relative private file names must be one segment"
    );
  }
  const configuration = platformConfiguration();
  const definitions: Record<string, FFIFunction> = {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    fchmod: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fsync: { args: [FFIType.i32], returns: FFIType.i32 },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    read: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    renameat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    unlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    write: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  };
  definitions[process.platform === "darwin" ? "__error" : "__errno_location"] =
    { args: [], returns: FFIType.ptr };
  const libc = openSystemLibc(configuration, definitions);
  const symbols = libc.symbols as unknown as PrivateFileMutationSymbols;
  const errnoPointer =
    process.platform === "darwin"
      ? symbols.__error!()
      : symbols.__errno_location!();
  const errno = new DataView(toArrayBuffer(errnoPointer!, 0, 4));
  const name = Buffer.from(`${args.fileName}\0`);
  const lockName = Buffer.from(`.${args.fileName}.lock\0`);
  const temporaryName = Buffer.from(`.${args.fileName}.${randomUUID()}.tmp\0`);
  let lockFd = -1;
  let temporaryFd = -1;

  const openExisting = (): number | null => {
    errno.setInt32(0, 0, true);
    const fd = symbols.openat(
      args.directoryFd,
      ptr(name),
      safeExistingOpenFlags(),
      0
    );
    if (fd >= 0) {
      return fd;
    }
    if (errno.getInt32(0, true) === 2) {
      return null;
    }
    throw new Error(
      `Descriptor-relative private file open failed closed: ${args.fileName}`
    );
  };
  const readExisting = (): PrivateFileSnapshot | null => {
    const fd = openExisting();
    if (fd === null) {
      return null;
    }
    try {
      const before = fstatSync(fd);
      if (!privateMutableFileIsSafe(before, args.maxBytes)) {
        throw new Error(`Private file is unsafe: ${args.fileName}`);
      }
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(
          symbols.read(fd, ptr(bytes, offset), bytes.length - offset)
        );
        if (count < 0) {
          throw new Error(`Could not read private file: ${args.fileName}`);
        }
        if (count === 0) {
          break;
        }
        offset += count;
      }
      if (offset !== before.size) {
        throw new Error(`Private file changed while reading: ${args.fileName}`);
      }
      const after = fstatSync(fd);
      if (!sameFileIdentity(before, after)) {
        throw new Error(`Private file changed while reading: ${args.fileName}`);
      }
      return {
        contents: new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, offset)
        ),
        metadata: before,
      };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Private file is not UTF-8: ${args.fileName}`);
      }
      throw error;
    } finally {
      symbols.close(fd);
    }
  };
  const assertUnchanged = (previous: PrivateFileSnapshot | null): void => {
    const current = readExisting();
    if (previous === null) {
      if (current !== null) {
        throw new Error(
          `Private file appeared during update: ${args.fileName}`
        );
      }
      return;
    }
    if (
      current === null ||
      !sameFileIdentity(previous.metadata, current.metadata) ||
      previous.contents !== current.contents
    ) {
      throw new Error(`Private file changed during update: ${args.fileName}`);
    }
  };

  try {
    lockFd = symbols.openat(
      args.directoryFd,
      ptr(lockName),
      configuration.createExclusive +
        (constants.O_NOFOLLOW ?? 0) +
        ((constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC ??
          0),
      0o600
    );
    const createdLock = lockFd >= 0;
    if (createdLock && symbols.fchmod(lockFd, 0o600) !== 0) {
      throw new Error(`Could not secure private file lock: ${args.fileName}`);
    }
    if (!createdLock) {
      lockFd = symbols.openat(
        args.directoryFd,
        ptr(lockName),
        constants.O_RDWR +
          (constants.O_NOFOLLOW ?? 0) +
          (constants.O_NONBLOCK ?? 0) +
          ((constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC ??
            0),
        0
      );
    }
    const lockMetadata = lockFd >= 0 ? fstatSync(lockFd) : null;
    if (
      lockFd < 0 ||
      !lockMetadata ||
      !privateMutableFileIsSafe(lockMetadata, args.maxBytes) ||
      lockMetadata.size !== 0 ||
      permissionBits(lockMetadata.mode) !== 0o600 ||
      symbols.flock(lockFd, 6) !== 0
    ) {
      throw new Error(
        `Private file update is already active: ${args.fileName}`
      );
    }
    const currentLockFd = symbols.openat(
      args.directoryFd,
      ptr(lockName),
      safeExistingOpenFlags(),
      0
    );
    if (currentLockFd < 0) {
      throw new Error(`Private file lock changed: ${args.fileName}`);
    }
    try {
      if (!sameFileIdentity(fstatSync(lockFd), fstatSync(currentLockFd))) {
        throw new Error(`Private file lock changed: ${args.fileName}`);
      }
    } finally {
      symbols.close(currentLockFd);
    }

    const previous = readExisting();
    const priorSha256 = previous
      ? createHash("sha256").update(previous.contents).digest("hex")
      : null;
    if (
      args.expectedPriorSha256 !== undefined &&
      priorSha256 !== args.expectedPriorSha256
    ) {
      throw new Error(
        `Private file no longer matches its receipt: ${args.fileName}`
      );
    }
    const contents = args.transform(previous?.contents ?? null);
    if (Buffer.byteLength(contents) > args.maxBytes) {
      throw new Error(`Private file exceeds byte limit: ${args.fileName}`);
    }
    temporaryFd = symbols.openat(
      args.directoryFd,
      ptr(temporaryName),
      configuration.createExclusive,
      0o600
    );
    if (temporaryFd < 0 || symbols.fchmod(temporaryFd, 0o600) !== 0) {
      throw new Error(
        `Descriptor-relative private temporary creation failed: ${args.fileName}`
      );
    }
    const bytes = Buffer.from(contents);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Number(
        symbols.write(temporaryFd, ptr(bytes, offset), bytes.length - offset)
      );
      if (count <= 0) {
        throw new Error(`Could not write private file: ${args.fileName}`);
      }
      offset += count;
    }
    if (symbols.fsync(temporaryFd) !== 0) {
      throw new Error(`Could not sync private file: ${args.fileName}`);
    }
    const temporaryMetadata = fstatSync(temporaryFd);
    if (!privateMutableFileIsSafe(temporaryMetadata, args.maxBytes)) {
      throw new Error(`Private temporary file is unsafe: ${args.fileName}`);
    }
    symbols.close(temporaryFd);
    temporaryFd = -1;

    await args.beforeCommit?.();
    assertUnchanged(previous);
    if (symbols.fsync(args.directoryFd) !== 0) {
      throw new Error(`Could not sync private directory: ${args.fileName}`);
    }
    if (
      symbols.renameat(
        args.directoryFd,
        ptr(temporaryName),
        args.directoryFd,
        ptr(name)
      ) !== 0
    ) {
      throw new Error(
        `Could not atomically replace private file: ${args.fileName}`
      );
    }
    symbols.fsync(args.directoryFd);
    const committed = readExisting();
    if (committed?.contents !== contents) {
      throw new Error(
        `Private file commit verification failed: ${args.fileName}`
      );
    }
    return { contents, previousContents: previous?.contents ?? null };
  } finally {
    if (lockFd >= 0) {
      symbols.close(lockFd);
    }
    if (temporaryFd >= 0) {
      symbols.close(temporaryFd);
    }
    symbols.unlinkat(args.directoryFd, ptr(temporaryName), 0);
    libc.close();
  }
}

function safeExistingOpenFlags(): number {
  if (!(constants.O_NOFOLLOW && constants.O_NONBLOCK !== undefined)) {
    throw new Error(
      "Descriptor-relative no-follow report verification is unsupported"
    );
  }
  return constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK;
}
