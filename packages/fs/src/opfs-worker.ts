// @hermetic/fs — OPFS Worker
//
// This file runs inside a dedicated Worker. It must be SELF-CONTAINED
// (no imports from other packages). Bundled as a string constant at build time.
//
// Handles filesystem operations against the Origin Private File System (OPFS)
// using createSyncAccessHandle() for synchronous I/O within the Worker.

let opfsRoot: FileSystemDirectoryHandle;

async function init(): Promise<void> {
  opfsRoot = await navigator.storage.getDirectory();
}

// === Handle Navigation ===

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function normPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { result.pop(); continue; }
    result.push(part);
  }
  return "/" + result.join("/");
}

async function navigateToDir(path: string): Promise<FileSystemDirectoryHandle> {
  const parts = splitPath(normPath(path));
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  return dir;
}

async function navigateToFile(path: string): Promise<FileSystemFileHandle> {
  const parts = splitPath(normPath(path));
  const fileName = parts.pop()!;
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  return dir.getFileHandle(fileName);
}

async function ensureDir(path: string): Promise<FileSystemDirectoryHandle> {
  const parts = splitPath(normPath(path));
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

// === FS Operations ===

async function readFile(path: string): Promise<ArrayBuffer> {
  const fileHandle = await navigateToFile(path);
  const accessHandle = await fileHandle.createSyncAccessHandle();
  try {
    const size = accessHandle.getSize();
    const buffer = new ArrayBuffer(size);
    accessHandle.read(new DataView(buffer), { at: 0 });
    return buffer;
  } finally {
    accessHandle.close();
  }
}

async function writeFile(path: string, data: ArrayBuffer, options?: { recursive?: boolean }): Promise<void> {
  if (options?.recursive) {
    const parts = splitPath(normPath(path));
    parts.pop(); // remove filename
    if (parts.length > 0) {
      await ensureDir("/" + parts.join("/"));
    }
  }

  const parts = splitPath(normPath(path));
  const fileName = parts.pop()!;
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const accessHandle = await fileHandle.createSyncAccessHandle();
  try {
    accessHandle.write(new DataView(data), { at: 0 });
    accessHandle.truncate(data.byteLength);
    accessHandle.flush();
  } finally {
    accessHandle.close();
  }
}

async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  if (options?.recursive) {
    await ensureDir(path);
    return;
  }
  const parts = splitPath(normPath(path));
  const name = parts.pop()!;
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  await dir.getDirectoryHandle(name, { create: true });
}

async function readdir(path: string): Promise<string[]> {
  const dir = await navigateToDir(path);
  const entries: string[] = [];
  for await (const key of (dir as any).keys()) {
    entries.push(key);
  }
  return entries.sort();
}

async function stat(path: string): Promise<{
  type: "file" | "directory";
  size: number;
  mode: number;
  atime: string;
  mtime: string;
  ctime: string;
}> {
  const normalized = normPath(path);
  const parts = splitPath(normalized);

  if (parts.length === 0) {
    const now = new Date().toISOString();
    return { type: "directory", size: 0, mode: 0o755, atime: now, mtime: now, ctime: now };
  }

  const parentPath = "/" + parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1];
  const parentDir = parts.length > 1 ? await navigateToDir(parentPath) : opfsRoot;

  // Try as file first
  try {
    const fileHandle = await parentDir.getFileHandle(name);
    const accessHandle = await fileHandle.createSyncAccessHandle();
    try {
      const size = accessHandle.getSize();
      const now = new Date().toISOString();
      return { type: "file", size, mode: 0o644, atime: now, mtime: now, ctime: now };
    } finally {
      accessHandle.close();
    }
  } catch {
    // Not a file, try as directory
    try {
      await parentDir.getDirectoryHandle(name);
      const now = new Date().toISOString();
      return { type: "directory", size: 0, mode: 0o755, atime: now, mtime: now, ctime: now };
    } catch {
      throw new DOMException(`Not found: ${path}`, "NotFoundError");
    }
  }
}

async function unlink(path: string): Promise<void> {
  const parts = splitPath(normPath(path));
  const name = parts.pop()!;
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  await dir.removeEntry(name);
}

async function rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  const parts = splitPath(normPath(path));
  const name = parts.pop()!;
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  await dir.removeEntry(name, { recursive: options?.recursive ?? false });
}

async function rename(oldPath: string, newPath: string): Promise<void> {
  // OPFS doesn't have native rename across directories
  // For files: read, write to new location, delete old
  const oldStat = await stat(oldPath);

  if (oldStat.type === "file") {
    const data = await readFile(oldPath);
    await writeFile(newPath, data, { recursive: false });
    await unlink(oldPath);
  } else {
    // For directories, we'd need to recursively copy — simplified for now
    throw new DOMException("Directory rename not yet supported in OPFS backend", "NotSupportedError");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(src: string, dest: string): Promise<void> {
  const data = await readFile(src);
  await writeFile(dest, data);
}

// === Error mapping ===

function mapFSError(err: unknown, syscall: string, path?: string): {
  name: string;
  message: string;
  code?: string;
  path?: string;
  syscall?: string;
} {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotFoundError":
        return { name: "ENOENT", message: `no such file or directory: ${path}`, code: "ENOENT", path, syscall };
      case "TypeMismatchError":
        return { name: "EISDIR", message: `is a directory: ${path}`, code: "EISDIR", path, syscall };
      case "InvalidModificationError":
        return { name: "ENOTEMPTY", message: `directory not empty: ${path}`, code: "ENOTEMPTY", path, syscall };
      case "NoModificationAllowedError":
        return { name: "EBUSY", message: `resource busy: ${path}`, code: "EBUSY", path, syscall };
      default:
        return { name: "EIO", message: err.message, code: "EIO", path, syscall };
    }
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message, code: (err as any).code, path, syscall };
  }
  return { name: "Error", message: String(err) };
}

// === Message handler ===

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  if (!msg?.__hermetic || msg.ns !== "fs") return;

  if (!opfsRoot) await init();

  try {
    let result: unknown;
    const transfer: Transferable[] = [];

    switch (msg.method) {
      case "readFile": {
        const buffer = await readFile(msg.args[0] as string);
        result = buffer;
        transfer.push(buffer);
        break;
      }
      case "writeFile": {
        await writeFile(msg.args[0] as string, msg.args[1] as ArrayBuffer, msg.args[2] as { recursive?: boolean } | undefined);
        result = undefined;
        break;
      }
      case "mkdir": {
        await mkdir(msg.args[0] as string, msg.args[1] as { recursive?: boolean } | undefined);
        result = undefined;
        break;
      }
      case "readdir": {
        result = await readdir(msg.args[0] as string);
        break;
      }
      case "stat": {
        result = await stat(msg.args[0] as string);
        break;
      }
      case "unlink": {
        await unlink(msg.args[0] as string);
        result = undefined;
        break;
      }
      case "rmdir": {
        await rmdir(msg.args[0] as string, msg.args[1] as { recursive?: boolean } | undefined);
        result = undefined;
        break;
      }
      case "rename": {
        await rename(msg.args[0] as string, msg.args[1] as string);
        result = undefined;
        break;
      }
      case "exists": {
        result = await exists(msg.args[0] as string);
        break;
      }
      case "copyFile": {
        await copyFile(msg.args[0] as string, msg.args[1] as string);
        result = undefined;
        break;
      }
      default:
        throw new Error(`Unknown FS method: ${msg.method}`);
    }

    (self as any).postMessage(
      { __hermetic: true, ns: "fs", id: msg.id, ok: true, value: result },
      transfer,
    );
  } catch (err: unknown) {
    (self as any).postMessage({
      __hermetic: true,
      ns: "fs",
      id: msg.id,
      ok: false,
      error: mapFSError(err, msg.method, msg.args?.[0]),
    });
  }
};
