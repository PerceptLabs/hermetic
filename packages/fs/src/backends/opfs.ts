// @hermetic/fs — OPFS backend (main-thread wrapper)
//
// Creates a dedicated Worker running opfs-worker.ts, communicates via
// HermeticChannel RPC. Implements HermeticFS interface by delegating to Worker.

import { HermeticChannel } from "@hermetic/core";
import type { HermeticFS, FileStat, WriteOptions, MkdirOptions, RmdirOptions, WatchCallback, WatchEvent } from "../types.js";

// The OPFS worker source is bundled as a string at build time
// via tsup's `define` or a virtual module. For now, we import it
// and use a Blob URL at runtime.
import OPFS_WORKER_SOURCE from "../opfs-worker.ts?raw";

export class OPFSFS implements HermeticFS {
  readonly backend = "opfs" as const;
  private channel: HermeticChannel;
  private worker: Worker;
  private watchers = new Map<string, Set<WatchCallback>>();
  private watchInterval?: ReturnType<typeof setInterval>;
  private lastSnapshot = new Map<string, string>(); // path -> mtime for polling

  constructor(worker: Worker, channel: HermeticChannel) {
    this.worker = worker;
    this.channel = channel;
  }

  static async create(): Promise<OPFSFS> {
    const blob = new Blob([OPFS_WORKER_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { type: "module" });
    URL.revokeObjectURL(url);

    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ __hermetic: true, ns: "init", port: port2 }, [port2]);

    // The worker uses self.onmessage directly, so we use the worker's
    // built-in port. We create a HermeticChannel on port1 and send
    // messages through the worker's postMessage.
    // Actually, the worker listens on self.onmessage, so we wrap the worker itself.
    const channel = new HermeticChannel(port1);

    // For OPFS, we post directly to the worker (not via MessageChannel port)
    // since the worker uses self.onmessage. Let's use a shim approach:
    // We'll create a wrapper that posts to worker and receives on worker.
    return new OPFSFS(worker, channel);
  }

  private async rpc(method: string, ...args: unknown[]): Promise<unknown> {
    // Direct worker RPC (not via HermeticChannel since worker uses self.onmessage)
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`OPFS RPC timeout: fs.${method}`));
      }, 30_000);

      const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg?.__hermetic || msg.id !== id) return;
        this.worker.removeEventListener("message", handler);
        clearTimeout(timeout);
        if (msg.ok) {
          resolve(msg.value);
        } else {
          const err = new Error(msg.error.message) as Error & { code?: string; path?: string };
          err.name = msg.error.name;
          err.code = msg.error.code;
          err.path = msg.error.path;
          reject(err);
        }
      };

      this.worker.addEventListener("message", handler);
      const transfer: Transferable[] = [];
      for (const arg of args) {
        if (arg instanceof ArrayBuffer) transfer.push(arg);
      }
      this.worker.postMessage(
        { __hermetic: true, ns: "fs", id, method, args },
        transfer,
      );
    });
  }

  async readFile(path: string, encoding?: "utf-8"): Promise<Uint8Array | string> {
    const buffer = (await this.rpc("readFile", path)) as ArrayBuffer;
    if (encoding === "utf-8") return new TextDecoder().decode(buffer);
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, data: Uint8Array | string, options?: WriteOptions): Promise<void> {
    const buffer = typeof data === "string"
      ? new TextEncoder().encode(data).buffer
      : data.buffer instanceof ArrayBuffer ? data.buffer : new Uint8Array(data).buffer;
    await this.rpc("writeFile", path, buffer, options);
    this.emitWatch("modify", path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.rpc("mkdir", path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.rpc("readdir", path)) as string[];
  }

  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    await this.rpc("rmdir", path, options);
  }

  async stat(path: string): Promise<FileStat> {
    const raw = (await this.rpc("stat", path)) as {
      type: "file" | "directory";
      size: number;
      mode: number;
      atime: string;
      mtime: string;
      ctime: string;
    };
    return {
      type: raw.type,
      size: raw.size,
      mode: raw.mode,
      atime: new Date(raw.atime),
      mtime: new Date(raw.mtime),
      ctime: new Date(raw.ctime),
    };
  }

  async lstat(path: string): Promise<FileStat> {
    // OPFS doesn't have symlinks, so lstat === stat
    return this.stat(path);
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // OPFS doesn't support permissions — no-op
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    // OPFS doesn't store timestamps — no-op
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw new Error("Symlinks not supported by OPFS backend");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("Symlinks not supported by OPFS backend");
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.rpc("rename", oldPath, newPath);
  }

  async unlink(path: string): Promise<void> {
    await this.rpc("unlink", path);
    this.emitWatch("delete", path);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await this.rpc("copyFile", src, dest);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.rpc("exists", path)) as boolean;
  }

  // === File watching (polling fallback) ===

  private emitWatch(type: WatchEvent["type"], path: string): void {
    this.watchers.get(path)?.forEach((cb) => cb({ type, path }));
  }

  watch(path: string, callback: WatchCallback): () => void {
    if (!this.watchers.has(path)) this.watchers.set(path, new Set());
    this.watchers.get(path)!.add(callback);

    // Start polling if not already
    if (!this.watchInterval) {
      this.watchInterval = setInterval(() => this.pollChanges(), 500);
    }

    return () => {
      this.watchers.get(path)?.delete(callback);
      if (this.watchers.get(path)?.size === 0) this.watchers.delete(path);
      if (this.watchers.size === 0 && this.watchInterval) {
        clearInterval(this.watchInterval);
        this.watchInterval = undefined;
      }
    };
  }

  private async pollChanges(): Promise<void> {
    // Simple polling — check stat for watched paths
    for (const [path] of this.watchers) {
      try {
        const s = await this.stat(path);
        const key = `${s.mtime.getTime()}:${s.size}`;
        const prev = this.lastSnapshot.get(path);
        if (prev !== undefined && prev !== key) {
          this.emitWatch("modify", path);
        }
        this.lastSnapshot.set(path, key);
      } catch {
        if (this.lastSnapshot.has(path)) {
          this.lastSnapshot.delete(path);
          this.emitWatch("delete", path);
        }
      }
    }
  }

  dispose(): void {
    if (this.watchInterval) clearInterval(this.watchInterval);
    this.channel.dispose();
    this.worker.terminate();
    this.watchers.clear();
    this.lastSnapshot.clear();
  }
}
