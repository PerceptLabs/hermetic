// @hermetic/fs — IndexedDB fallback backend
//
// Uses IndexedDB to store filesystem nodes. Each node is a record with a path
// as primary key. Provides the same HermeticFS interface as memory and OPFS.
// Used when OPFS is unavailable (Firefox < 111, some Safari configs).

import {
  normalizePath,
  dirname,
  basename,
  ENOENT,
  EISDIR,
  ENOTDIR,
  ENOTEMPTY,
  EEXIST,
} from "@hermetic/core";
import type { HermeticFS, FileStat, WriteOptions, MkdirOptions, RmdirOptions, WatchCallback, WatchEvent } from "../types.js";

const DB_NAME = "hermetic-fs";
const STORE_NAME = "files";
const DB_VERSION = 1;

interface IDBNode {
  path: string;        // primary key
  type: "file" | "directory";
  content?: ArrayBuffer;
  mode: number;
  mtime: number;
  ctime: number;
}

export class IndexedDBFS implements HermeticFS {
  readonly backend = "indexeddb" as const;
  private db: IDBDatabase;
  private watchers = new Map<string, Set<WatchCallback>>();

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async create(dbName = DB_NAME): Promise<IndexedDBFS> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "path" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const fs = new IndexedDBFS(db);

    // Ensure root exists
    await fs.ensureNode("/", "directory");
    return fs;
  }

  private async ensureNode(path: string, type: "file" | "directory"): Promise<void> {
    const existing = await this.getNode(path);
    if (!existing) {
      const now = Date.now();
      await this.putNode({ path, type, mode: type === "directory" ? 0o755 : 0o644, mtime: now, ctime: now });
    }
  }

  private getNode(path: string): Promise<IDBNode | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(path);
      req.onsuccess = () => resolve(req.result ?? undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private putNode(node: IDBNode): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(node);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private deleteNode(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private getAllNodes(): Promise<IDBNode[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async readFile(path: string, encoding?: "utf-8"): Promise<Uint8Array | string> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    if (!node) throw ENOENT("readFile", normalized);
    if (node.type === "directory") throw EISDIR("readFile", normalized);
    const buffer = node.content ?? new ArrayBuffer(0);
    if (encoding === "utf-8") return new TextDecoder().decode(buffer);
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, data: Uint8Array | string, options?: WriteOptions): Promise<void> {
    const normalized = normalizePath(path);
    const parent = dirname(normalized);

    // Check parent exists
    if (parent !== normalized) {
      if (options?.recursive) {
        await this.mkdir(parent, { recursive: true });
      } else {
        const parentNode = await this.getNode(parent);
        if (!parentNode) throw ENOENT("writeFile", parent);
        if (parentNode.type !== "directory") throw ENOTDIR("writeFile", parent);
      }
    }

    // Check not writing to a directory
    const existing = await this.getNode(normalized);
    if (existing?.type === "directory") throw EISDIR("writeFile", normalized);

    const content = typeof data === "string"
      ? new TextEncoder().encode(data).buffer
      : (data.buffer instanceof ArrayBuffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : new Uint8Array(data).buffer);

    const now = Date.now();
    await this.putNode({
      path: normalized,
      type: "file",
      content,
      mode: options?.mode ?? 0o644,
      mtime: now,
      ctime: existing ? existing.ctime : now,
    });

    this.emitWatch("modify", normalized);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/") return; // root always exists

    if (options?.recursive) {
      const parts = normalized.split("/").filter(Boolean);
      let current = "/";
      for (const part of parts) {
        current = current === "/" ? `/${part}` : `${current}/${part}`;
        const existing = await this.getNode(current);
        if (!existing) {
          const now = Date.now();
          await this.putNode({ path: current, type: "directory", mode: options?.mode ?? 0o755, mtime: now, ctime: now });
        } else if (existing.type !== "directory") {
          throw ENOTDIR("mkdir", current);
        }
      }
      return;
    }

    const parent = dirname(normalized);
    const parentNode = await this.getNode(parent);
    if (!parentNode) throw ENOENT("mkdir", parent);

    const existing = await this.getNode(normalized);
    if (existing) throw EEXIST("mkdir", normalized);

    const now = Date.now();
    await this.putNode({ path: normalized, type: "directory", mode: options?.mode ?? 0o755, mtime: now, ctime: now });
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    if (!node) throw ENOENT("readdir", normalized);
    if (node.type !== "directory") throw ENOTDIR("readdir", normalized);

    const prefix = normalized === "/" ? "/" : normalized + "/";
    const all = await this.getAllNodes();
    const entries: string[] = [];

    for (const n of all) {
      if (n.path !== normalized && n.path.startsWith(prefix)) {
        const rest = n.path.slice(prefix.length);
        if (!rest.includes("/")) {
          entries.push(rest);
        }
      }
    }

    return entries.sort();
  }

  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    if (!node) throw ENOENT("rmdir", normalized);
    if (node.type !== "directory") throw ENOTDIR("rmdir", normalized);

    const children = await this.readdir(normalized);

    if (children.length > 0 && !options?.recursive) {
      throw ENOTEMPTY("rmdir", normalized);
    }

    if (options?.recursive) {
      // Delete all descendants
      const prefix = normalized === "/" ? "/" : normalized + "/";
      const all = await this.getAllNodes();
      for (const n of all) {
        if (n.path.startsWith(prefix)) {
          await this.deleteNode(n.path);
        }
      }
    }

    await this.deleteNode(normalized);
    this.emitWatch("delete", normalized);
  }

  async stat(path: string): Promise<FileStat> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    if (!node) throw ENOENT("stat", normalized);

    return {
      type: node.type,
      size: node.content?.byteLength ?? 0,
      mode: node.mode,
      atime: new Date(node.mtime),
      mtime: new Date(node.mtime),
      ctime: new Date(node.ctime),
    };
  }

  async lstat(path: string): Promise<FileStat> {
    return this.stat(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    if (!node) throw ENOENT("chmod", normalized);
    node.mode = mode;
    await this.putNode(node);
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    if (!node) throw ENOENT("utimes", normalized);
    node.mtime = mtime.getTime();
    await this.putNode(node);
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw new Error("Symlinks not supported by IndexedDB backend");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("Symlinks not supported by IndexedDB backend");
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);

    const node = await this.getNode(normalizedOld);
    if (!node) throw ENOENT("rename", normalizedOld);

    // Check new parent exists
    const newParent = dirname(normalizedNew);
    if (newParent !== normalizedNew) {
      const parentNode = await this.getNode(newParent);
      if (!parentNode) throw ENOENT("rename", newParent);
    }

    if (node.type === "file") {
      node.path = normalizedNew;
      await this.putNode(node);
      await this.deleteNode(normalizedOld);
    } else {
      // Directory rename — move all descendants
      const prefix = normalizedOld === "/" ? "/" : normalizedOld + "/";
      const all = await this.getAllNodes();
      for (const n of all) {
        if (n.path.startsWith(prefix)) {
          const newNodePath = normalizedNew + n.path.slice(normalizedOld.length);
          n.path = newNodePath;
          await this.putNode(n);
          await this.deleteNode(normalizedOld + n.path.slice(normalizedNew.length));
        }
      }
      node.path = normalizedNew;
      await this.putNode(node);
      await this.deleteNode(normalizedOld);
    }
  }

  async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    if (!node) throw ENOENT("unlink", normalized);
    if (node.type === "directory") throw EISDIR("unlink", normalized);
    await this.deleteNode(normalized);
    this.emitWatch("delete", normalized);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const normalizedSrc = normalizePath(src);
    const normalizedDest = normalizePath(dest);

    const node = await this.getNode(normalizedSrc);
    if (!node) throw ENOENT("copyFile", normalizedSrc);
    if (node.type === "directory") throw EISDIR("copyFile", normalizedSrc);

    const now = Date.now();
    await this.putNode({
      path: normalizedDest,
      type: "file",
      content: node.content ? node.content.slice(0) : new ArrayBuffer(0),
      mode: node.mode,
      mtime: now,
      ctime: now,
    });
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const node = await this.getNode(normalized);
    return !!node;
  }

  // === File watching ===

  private emitWatch(type: WatchEvent["type"], path: string): void {
    this.watchers.get(path)?.forEach((cb) => cb({ type, path }));
    // Also notify parent directory watchers
    const parent = dirname(path);
    if (parent !== path) {
      this.watchers.get(parent)?.forEach((cb) => cb({ type, path }));
    }
  }

  watch(path: string, callback: WatchCallback): () => void {
    const normalized = normalizePath(path);
    if (!this.watchers.has(normalized)) this.watchers.set(normalized, new Set());
    this.watchers.get(normalized)!.add(callback);

    return () => {
      this.watchers.get(normalized)?.delete(callback);
      if (this.watchers.get(normalized)?.size === 0) this.watchers.delete(normalized);
    };
  }

  dispose(): void {
    this.db.close();
    this.watchers.clear();
  }
}
