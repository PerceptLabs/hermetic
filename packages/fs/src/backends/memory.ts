// @hermetic/fs — In-memory filesystem backend
//
// Complete Map-based FS implementation. Used as ground truth for testing
// and as fallback when OPFS is not available.

import {
  normalizePath,
  dirname,
  basename,
  ENOENT,
  EISDIR,
  ENOTDIR,
  ENOTEMPTY,
  EEXIST,
  ELOOP,
} from "@hermetic/core";
import type { HermeticFS, FileStat, WriteOptions, MkdirOptions, RmdirOptions, WatchCallback, WatchEvent } from "../types.js";

interface FileNode {
  type: "file";
  content: Uint8Array;
  mode: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
}

interface DirNode {
  type: "directory";
  mode: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
}

interface SymlinkNode {
  type: "symlink";
  target: string;
  mode: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
}

type FSNode = FileNode | DirNode | SymlinkNode;

const MAX_SYMLINK_DEPTH = 40;

export class MemoryFS implements HermeticFS {
  readonly backend = "memory" as const;
  private nodes = new Map<string, FSNode>();
  private watchers = new Map<string, Set<WatchCallback>>();

  constructor() {
    const now = new Date();
    this.nodes.set("/", { type: "directory", mode: 0o755, atime: now, mtime: now, ctime: now });
  }

  // === Path resolution with symlink handling ===

  private resolveSymlinks(path: string, depth = 0): string {
    if (depth > MAX_SYMLINK_DEPTH) throw ELOOP(path);
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node || node.type !== "symlink") return normalized;
    // Symlink target can be relative or absolute
    const target = node.target.startsWith("/")
      ? node.target
      : normalizePath(dirname(normalized) + "/" + node.target);
    return this.resolveSymlinks(target, depth + 1);
  }

  private resolve(path: string): string {
    return this.resolveSymlinks(normalizePath(path));
  }

  private getNode(path: string): FSNode | undefined {
    return this.nodes.get(this.resolve(path));
  }

  private ensureParentExists(path: string, syscall: string): void {
    const parent = dirname(path);
    const parentNode = this.nodes.get(this.resolveSymlinks(parent));
    if (!parentNode) throw ENOENT(parent, syscall);
    if (parentNode.type !== "directory") throw ENOTDIR(parent, syscall);
  }

  // === Notification ===

  private emitWatch(type: WatchEvent["type"], path: string): void {
    const normalized = normalizePath(path);
    // Notify watchers on exact path
    this.watchers.get(normalized)?.forEach((cb) => cb({ type, path: normalized }));
    // Notify watchers on parent directory
    const parent = dirname(normalized);
    this.watchers.get(parent)?.forEach((cb) => cb({ type, path: normalized }));
  }

  // === HermeticFS interface implementation ===

  async readFile(path: string, encoding?: "utf-8"): Promise<Uint8Array | string> {
    const resolved = this.resolve(path);
    const node = this.nodes.get(resolved);
    if (!node) throw ENOENT(path, "read");
    if (node.type === "directory") throw EISDIR(path, "read");
    if (node.type === "symlink") throw ENOENT(path, "read"); // shouldn't reach here after resolve
    const data = node.content;
    if (encoding === "utf-8") return new TextDecoder().decode(data);
    return new Uint8Array(data);
  }

  async writeFile(path: string, data: Uint8Array | string, options?: WriteOptions): Promise<void> {
    const normalized = normalizePath(path);

    if (options?.recursive) {
      await this.mkdir(dirname(normalized), { recursive: true });
    }

    this.ensureParentExists(normalized, "write");

    // Check if target is a directory
    const existing = this.getNode(normalized);
    if (existing?.type === "directory") throw EISDIR(path, "write");

    const content = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const now = new Date();
    const resolved = this.resolveSymlinks(normalized);

    const existingResolved = this.nodes.get(resolved);
    if (existingResolved && existingResolved.type === "file") {
      existingResolved.content = content;
      existingResolved.mtime = now;
      existingResolved.atime = now;
      this.emitWatch("modify", resolved);
    } else {
      this.nodes.set(resolved, {
        type: "file",
        content,
        mode: options?.mode ?? 0o644,
        atime: now,
        mtime: now,
        ctime: now,
      });
      this.emitWatch("create", resolved);
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/") return; // root always exists

    if (options?.recursive) {
      const parts = normalized.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += "/" + part;
        const node = this.nodes.get(current);
        if (node) {
          if (node.type !== "directory") throw ENOTDIR(current, "mkdir");
          continue;
        }
        const now = new Date();
        this.nodes.set(current, { type: "directory", mode: options?.mode ?? 0o755, atime: now, mtime: now, ctime: now });
        this.emitWatch("create", current);
      }
      return;
    }

    this.ensureParentExists(normalized, "mkdir");
    const existing = this.nodes.get(normalized);
    if (existing) throw EEXIST(path, "mkdir");

    const now = new Date();
    this.nodes.set(normalized, { type: "directory", mode: options?.mode ?? 0o755, atime: now, mtime: now, ctime: now });
    this.emitWatch("create", normalized);
  }

  async readdir(path: string): Promise<string[]> {
    const resolved = this.resolve(path);
    const node = this.nodes.get(resolved);
    if (!node) throw ENOENT(path, "readdir");
    if (node.type !== "directory") throw ENOTDIR(path, "readdir");

    const prefix = resolved === "/" ? "/" : resolved + "/";
    const entries: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key === resolved) continue;
      if (!key.startsWith(prefix)) continue;
      // Only direct children
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      entries.push(rest);
    }
    return entries.sort();
  }

  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/") throw ENOTEMPTY("/", "rmdir");

    const node = this.nodes.get(normalized);
    if (!node) throw ENOENT(path, "rmdir");
    if (node.type !== "directory") throw ENOTDIR(path, "rmdir");

    if (options?.recursive) {
      // Remove all descendants
      const prefix = normalized + "/";
      const toDelete: string[] = [];
      for (const key of this.nodes.keys()) {
        if (key === normalized || key.startsWith(prefix)) {
          toDelete.push(key);
        }
      }
      for (const key of toDelete) {
        this.nodes.delete(key);
      }
      this.emitWatch("delete", normalized);
      return;
    }

    // Check if empty
    const children = await this.readdir(path);
    if (children.length > 0) throw ENOTEMPTY(path, "rmdir");

    this.nodes.delete(normalized);
    this.emitWatch("delete", normalized);
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = this.resolve(path);
    const node = this.nodes.get(resolved);
    if (!node) throw ENOENT(path, "stat");
    return {
      type: node.type,
      size: node.type === "file" ? node.content.byteLength : 0,
      mode: node.mode,
      atime: node.atime,
      mtime: node.mtime,
      ctime: node.ctime,
    };
  }

  async lstat(path: string): Promise<FileStat> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw ENOENT(path, "lstat");
    return {
      type: node.type,
      size: node.type === "file" ? node.content.byteLength : 0,
      mode: node.mode,
      atime: node.atime,
      mtime: node.mtime,
      ctime: node.ctime,
      target: node.type === "symlink" ? node.target : undefined,
    };
  }

  async chmod(path: string, mode: number): Promise<void> {
    const resolved = this.resolve(path);
    const node = this.nodes.get(resolved);
    if (!node) throw ENOENT(path, "chmod");
    node.mode = mode;
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const resolved = this.resolve(path);
    const node = this.nodes.get(resolved);
    if (!node) throw ENOENT(path, "utimes");
    node.atime = atime;
    node.mtime = mtime;
  }

  async symlink(target: string, path: string): Promise<void> {
    const normalized = normalizePath(path);
    this.ensureParentExists(normalized, "symlink");

    if (this.nodes.has(normalized)) throw EEXIST(path, "symlink");

    const now = new Date();
    this.nodes.set(normalized, {
      type: "symlink",
      target,
      mode: 0o777,
      atime: now,
      mtime: now,
      ctime: now,
    });
    this.emitWatch("create", normalized);
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw ENOENT(path, "readlink");
    if (node.type !== "symlink") {
      const err = new Error(`EINVAL: invalid argument, readlink '${path}'`);
      (err as Error & { code: string }).code = "EINVAL";
      throw err;
    }
    return node.target;
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);

    const node = this.nodes.get(oldNorm);
    if (!node) throw ENOENT(oldPath, "rename");

    this.ensureParentExists(newNorm, "rename");

    // If renaming a directory, move all descendants
    if (node.type === "directory") {
      const prefix = oldNorm + "/";
      const toMove: [string, FSNode][] = [];
      for (const [key, val] of this.nodes.entries()) {
        if (key === oldNorm || key.startsWith(prefix)) {
          toMove.push([key, val]);
        }
      }
      for (const [key] of toMove) {
        this.nodes.delete(key);
      }
      for (const [key, val] of toMove) {
        const newKey = key === oldNorm ? newNorm : newNorm + key.slice(oldNorm.length);
        this.nodes.set(newKey, val);
      }
    } else {
      this.nodes.delete(oldNorm);
      this.nodes.set(newNorm, node);
    }

    this.emitWatch("delete", oldNorm);
    this.emitWatch("create", newNorm);
  }

  async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw ENOENT(path, "unlink");
    if (node.type === "directory") throw EISDIR(path, "unlink");

    this.nodes.delete(normalized);
    this.emitWatch("delete", normalized);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const data = await this.readFile(src);
    await this.writeFile(dest, data as Uint8Array);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const resolved = this.resolve(path);
      return this.nodes.has(resolved);
    } catch {
      return false;
    }
  }

  watch(path: string, callback: WatchCallback): () => void {
    const normalized = normalizePath(path);
    if (!this.watchers.has(normalized)) this.watchers.set(normalized, new Set());
    this.watchers.get(normalized)!.add(callback);
    return () => {
      this.watchers.get(normalized)?.delete(callback);
    };
  }

  dispose(): void {
    this.nodes.clear();
    this.watchers.clear();
  }
}
