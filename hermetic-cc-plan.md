# Hermetic: Claude Code Implementation Plan

**Companion to:** `hermetic-spec.md` (the WHAT)
**This document:** The HOW — file-by-file implementation details, bootstrapping sequences, error propagation, disposal patterns, and edge cases.

**Rules for CC:**
- Read `hermetic-spec.md` FIRST for architecture and design principles
- This document provides implementation-level guidance for each package
- Implement packages in the order specified — each builds on the last
- Every package must work independently (composable, not monolithic)
- Every package must have tests that run in vitest browser mode
- NEVER use SharedArrayBuffer, Service Workers for networking, or cross-origin iframes
- NEVER reference WebContainers source, docs, or implementation

---

## 0. Project Bootstrap

### 0.1 Initialize Monorepo

```bash
mkdir hermetic && cd hermetic
pnpm init
```

Root `package.json`:
```json
{
  "name": "hermetic",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:browser": "pnpm -r test:browser",
    "lint": "eslint packages/",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@vitest/browser": "^2.0.0",
    "playwright": "^1.45.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0"
  }
}
```

Root `pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

Root `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]
  }
}
```

### 0.2 Per-Package Template

Every package under `packages/` follows this structure:
```
packages/{name}/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts          # Public API exports
│   ├── types.ts           # Package-specific types
│   └── ...implementation
├── tests/
│   ├── {name}.test.ts     # Unit tests
│   └── {name}.browser.test.ts  # Browser API tests (vitest browser mode)
└── README.md
```

Per-package `package.json` template:
```json
{
  "name": "@hermetic/{name}",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:browser": "vitest run --browser.name=chromium"
  },
  "files": ["dist"]
}
```

Per-package `tsup.config.ts`:
```typescript
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
```

---

## 1. Package: @hermetic/core

**Purpose:** Shared types, MessageChannel protocol, request/response correlation, capability binding base class, error types, and utilities used by ALL other packages.

**This package is the backbone. Get it right before touching anything else.**

### 1.1 Files

```
packages/core/src/
├── index.ts              # Re-exports everything
├── types.ts              # Core type definitions
├── protocol.ts           # MessageChannel wire protocol
├── channel.ts            # RPC-over-MessageChannel abstraction
├── errors.ts             # Hermetic error types
├── disposable.ts         # Disposal/cleanup pattern
└── utils.ts              # Path normalization, ID generation
```

### 1.2 The MessageChannel Protocol (`protocol.ts`)

This is the most critical file in the entire project. Every cross-context communication flows through this protocol. It must be:
- Fully typed as discriminated unions
- Serializable via structured clone (no functions, no class instances)
- Correlation-based (every request has an `id`, every response references it)
- Error-aware (every operation can fail, errors must cross boundaries cleanly)

```typescript
// === UNIVERSAL ENVELOPE ===

// Every message has a namespace prefix and correlation ID
// Namespace prevents collisions when multiple subsystems share a channel

export type RequestMessage = {
  __hermetic: true;          // Brand field for identification
  ns: string;                // Namespace: "fs" | "net" | "proc" | "vm"
  id: string;                // Correlation ID (nanoid or crypto.randomUUID)
  method: string;            // e.g., "readFile", "request", "spawn"
  args: unknown[];           // Method arguments (must be structured-clone-safe)
  transfer?: ArrayBuffer[];  // Transferable objects to zero-copy
};

export type ResponseMessage = {
  __hermetic: true;
  ns: string;
  id: string;               // Matches request ID
} & (
  | { ok: true; value: unknown; transfer?: ArrayBuffer[] }
  | { ok: false; error: SerializedError }
);

export type StreamMessage = {
  __hermetic: true;
  ns: string;
  id: string;
  stream: "chunk" | "end" | "error";
  data?: ArrayBuffer;
  error?: string;
};

export type NotificationMessage = {
  __hermetic: true;
  ns: string;
  event: string;             // e.g., "fs.change", "proc.exit", "proc.stdout"
  data: unknown;
};

export type HermeticMessage =
  | RequestMessage
  | ResponseMessage
  | StreamMessage
  | NotificationMessage;

// === ERROR SERIALIZATION ===
// Errors can't cross MessageChannel as Error instances
// They must be plain objects

export interface SerializedError {
  name: string;              // "ENOENT", "EACCES", "TIMEOUT", etc.
  message: string;
  code?: string;             // POSIX error code
  path?: string;             // For FS errors
  syscall?: string;          // For FS errors
  stack?: string;            // Development only
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      code: (err as any).code,
      path: (err as any).path,
      syscall: (err as any).syscall,
      stack: err.stack,
    };
  }
  return { name: "Error", message: String(err) };
}

export function deserializeError(se: SerializedError): Error {
  const err = new Error(se.message);
  err.name = se.name;
  (err as any).code = se.code;
  (err as any).path = se.path;
  (err as any).syscall = se.syscall;
  return err;
}
```

### 1.3 The RPC Channel (`channel.ts`)

This is the abstraction that makes MessageChannel feel like async function calls. Every other package uses this to talk across boundaries.

```typescript
/**
 * RPC-over-MessageChannel.
 *
 * Usage (host side):
 *   const channel = new HermeticChannel(port);
 *   channel.handle("fs", {
 *     readFile: async (path: string) => { ... },
 *     writeFile: async (path: string, data: ArrayBuffer) => { ... },
 *   });
 *
 * Usage (sandbox side):
 *   const channel = new HermeticChannel(port);
 *   const data = await channel.call("fs", "readFile", ["/app.ts"]);
 */
export class HermeticChannel {
  private port: MessagePort;
  private pending: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  private handlers: Map<string, Record<string, (...args: any[]) => Promise<unknown>>>;
  private listeners: Map<string, Set<(data: unknown) => void>>;
  private disposed: boolean;

  constructor(port: MessagePort, private defaultTimeout = 30_000) {
    this.port = port;
    this.pending = new Map();
    this.handlers = new Map();
    this.listeners = new Map();
    this.disposed = false;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  // --- Caller side: make a request, get a response ---

  async call(ns: string, method: string, args: unknown[], transfer?: Transferable[]): Promise<unknown> {
    if (this.disposed) throw new Error("Channel disposed");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermetic RPC timeout: ${ns}.${method} (${this.defaultTimeout}ms)`));
      }, this.defaultTimeout);
      this.pending.set(id, { resolve, reject, timeout });

      const msg: RequestMessage = {
        __hermetic: true, ns, id, method,
        args: args,
      };
      // Extract ArrayBuffers from args for transfer
      const transferList: Transferable[] = transfer ?? [];
      this.port.postMessage(msg, transferList);
    });
  }

  // --- Handler side: register methods that respond to requests ---

  handle(ns: string, methods: Record<string, (...args: any[]) => Promise<unknown>>): void {
    this.handlers.set(ns, methods);
  }

  // --- Event listening for notifications ---

  on(event: string, callback: (data: unknown) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  notify(ns: string, event: string, data: unknown): void {
    const msg: NotificationMessage = { __hermetic: true, ns, event, data };
    this.port.postMessage(msg);
  }

  // --- Internal message routing ---

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object" || !(msg as any).__hermetic) return;
    const m = msg as HermeticMessage;

    // Response to our request
    if ("ok" in m) {
      const resp = m as ResponseMessage;
      const handler = this.pending.get(resp.id);
      if (!handler) return;
      this.pending.delete(resp.id);
      clearTimeout(handler.timeout);
      if (resp.ok) handler.resolve(resp.value);
      else handler.reject(deserializeError(resp.error));
      return;
    }

    // Request for us to handle
    if ("method" in m && "id" in m && !("ok" in m) && !("stream" in m) && !("event" in m)) {
      const req = m as RequestMessage;
      const handler = this.handlers.get(req.ns);
      if (!handler || !handler[req.method]) {
        this.port.postMessage({
          __hermetic: true, ns: req.ns, id: req.id,
          ok: false, error: { name: "Error", message: `Unknown method: ${req.ns}.${req.method}` },
        } satisfies ResponseMessage);
        return;
      }
      try {
        const value = await handler[req.method](...req.args);
        // Detect ArrayBuffer results for zero-copy transfer
        const transfer: Transferable[] = [];
        if (value instanceof ArrayBuffer) transfer.push(value);
        this.port.postMessage(
          { __hermetic: true, ns: req.ns, id: req.id, ok: true, value } satisfies ResponseMessage,
          transfer
        );
      } catch (err) {
        this.port.postMessage({
          __hermetic: true, ns: req.ns, id: req.id,
          ok: false, error: serializeError(err),
        } satisfies ResponseMessage);
      }
      return;
    }

    // Notification (no response expected)
    if ("event" in m) {
      const notif = m as NotificationMessage;
      const key = `${notif.ns}.${notif.event}`;
      this.listeners.get(key)?.forEach((cb) => cb(notif.data));
      return;
    }

    // Stream messages handled by streaming layer (see below)
  }

  // --- Cleanup ---

  dispose(): void {
    this.disposed = true;
    for (const [, handler] of this.pending) {
      clearTimeout(handler.timeout);
      handler.reject(new Error("Channel disposed"));
    }
    this.pending.clear();
    this.handlers.clear();
    this.listeners.clear();
    this.port.close();
  }
}
```

**CRITICAL IMPLEMENTATION NOTES FOR CC:**

1. `crypto.randomUUID()` is available in all modern browsers and Workers. Use it for correlation IDs. Do NOT use `Math.random()`.

2. The `transfer` parameter in `postMessage` is how you achieve zero-copy. When you transfer an `ArrayBuffer`, ownership moves to the receiver — the sender can no longer use it. Use this for file contents and network response bodies.

3. Timeout is essential. Without it, a crashed Worker leaves Promises hanging forever. Default 30s, configurable.

4. The `__hermetic: true` brand field prevents collisions with other postMessage traffic on the same port.

5. Error serialization/deserialization MUST happen at the boundary. Raw `Error` objects cannot cross `postMessage`. This is the #1 bug CC will create if not careful.

### 1.4 Disposable Pattern (`disposable.ts`)

```typescript
export interface Disposable {
  dispose(): void;
}

export class DisposableStore {
  private items: Disposable[] = [];

  add<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  dispose(): void {
    for (const item of this.items.reverse()) {
      try { item.dispose(); } catch {}
    }
    this.items = [];
  }
}
```

Every subsystem that creates Workers, iframes, or channel connections MUST use this pattern. Browser resources leak silently — Workers keep running, MessagePorts stay open, OPFS handles stay locked. Explicit disposal is mandatory.

### 1.5 Path Utilities (`utils.ts`)

```typescript
/**
 * POSIX path normalization.
 * - Resolves `.` and `..`
 * - Removes double slashes
 * - Removes trailing slashes (except root)
 * - Always starts with `/`
 */
export function normalizePath(path: string): string { ... }
export function joinPath(...segments: string[]): string { ... }
export function dirname(path: string): string { ... }
export function basename(path: string): string { ... }
export function extname(path: string): string { ... }
export function isAbsolute(path: string): boolean { ... }

/**
 * Resolve a path relative to a working directory.
 * resolvePath("/home", "./foo/bar") => "/home/foo/bar"
 * resolvePath("/home", "/absolute") => "/absolute"
 */
export function resolvePath(cwd: string, path: string): string { ... }

/**
 * MIME type guess from file extension.
 * Used by HermeticNet to set Content-Type headers.
 */
export function guessMimeType(path: string): string { ... }
```

Implement these from scratch. Do NOT import `path` from Node.js. These must work in browsers and Workers. POSIX semantics only (forward slashes, no drive letters).

### 1.6 Tests for @hermetic/core

```typescript
// tests/protocol.test.ts
describe("HermeticChannel", () => {
  it("sends request and receives response", async () => {
    const { port1, port2 } = new MessageChannel();
    const caller = new HermeticChannel(port1);
    const handler = new HermeticChannel(port2);

    handler.handle("math", {
      add: async (a: number, b: number) => a + b,
    });

    const result = await caller.call("math", "add", [2, 3]);
    expect(result).toBe(5);

    caller.dispose();
    handler.dispose();
  });

  it("propagates errors across channel", async () => { ... });
  it("times out on unresponsive handler", async () => { ... });
  it("transfers ArrayBuffer without copying", async () => { ... });
  it("handles rapid concurrent requests", async () => { ... });
  it("rejects pending requests on dispose", async () => { ... });
  it("ignores non-hermetic messages", async () => { ... });
});
```

---

## 2. Package: @hermetic/fs

**Purpose:** Virtual filesystem with OPFS, IndexedDB, and in-memory backends.

**Depends on:** `@hermetic/core`

### 2.1 Files

```
packages/fs/src/
├── index.ts               # Public API: createFS(), type exports
├── types.ts               # FileStat, WriteOptions, WatchEvent, etc.
├── fs.ts                  # Main HermeticFS class (facade over backends)
├── backends/
│   ├── opfs.ts            # OPFS backend (primary, Worker-based)
│   ├── indexeddb.ts       # IndexedDB backend (fallback)
│   └── memory.ts          # In-memory backend (testing)
├── opfs-worker.ts         # The actual Worker script for OPFS operations
├── path.ts                # Path resolution (re-exports from @hermetic/core)
├── watch.ts               # File watching (FileSystemObserver + polling fallback)
└── layered.ts             # Union mount / layered FS (optional, Phase 2)
```

### 2.2 OPFS Worker Architecture

**This is the trickiest part of HermeticFS.** The OPFS Worker is a dedicated Web Worker that:
1. Opens the OPFS root on initialization
2. Maintains a cache of `FileSystemDirectoryHandle` and `FileSystemSyncAccessHandle` objects
3. Receives filesystem operation requests via MessageChannel
4. Executes operations synchronously using `createSyncAccessHandle()`
5. Returns results back through MessageChannel

```
Main Thread (host page)
    │
    │ MessageChannel port
    │
    ▼
OPFS Worker
    │
    ├── navigator.storage.getDirectory() → root handle
    │
    ├── Maintains handle cache:
    │   Map<string, FileSystemDirectoryHandle | FileSystemFileHandle>
    │
    ├── For reads:
    │   handle.createSyncAccessHandle({ mode: "read-only" })
    │   → accessHandle.read(buffer, { at: 0 })
    │   → accessHandle.close()  // MUST close to release lock
    │   → transfer buffer back to caller
    │
    ├── For writes:
    │   handle.createSyncAccessHandle()  // default readwrite
    │   → accessHandle.write(data, { at: 0 })
    │   → accessHandle.truncate(data.byteLength)  // in case file was larger
    │   → accessHandle.flush()
    │   → accessHandle.close()  // MUST close
    │
    └── For directory ops:
        handle.getDirectoryHandle(name, { create: true })
        handle.getFileHandle(name, { create: true })
        handle.removeEntry(name, { recursive: true })
```

**CRITICAL: Access Handle Lifecycle**

`createSyncAccessHandle()` takes an EXCLUSIVE LOCK on the file. If you don't close it, no other operation can access that file. This is the #1 source of bugs in OPFS code.

Pattern: ALWAYS use try/finally:
```typescript
async function readFile(path: string): Promise<ArrayBuffer> {
  const fileHandle = await navigateToFile(path);
  const accessHandle = await fileHandle.createSyncAccessHandle({ mode: "read-only" });
  try {
    const size = accessHandle.getSize();
    const buffer = new ArrayBuffer(size);
    accessHandle.read(new DataView(buffer), { at: 0 });
    return buffer; // Will be transferred, not copied
  } finally {
    accessHandle.close(); // ALWAYS close, even on error
  }
}
```

**Handle Navigation**

Navigating from root to a nested path requires walking the directory tree:

```typescript
async function navigateToFile(path: string): Promise<FileSystemFileHandle> {
  const parts = normalizePath(path).split("/").filter(Boolean);
  const fileName = parts.pop()!;
  let dir = opfsRoot; // cached root FileSystemDirectoryHandle
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
    // Throws DOMException "NotFoundError" if doesn't exist
  }
  return dir.getFileHandle(fileName);
}

async function navigateToDir(path: string): Promise<FileSystemDirectoryHandle> {
  const parts = normalizePath(path).split("/").filter(Boolean);
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  return dir;
}

// With create option:
async function ensureDir(path: string): Promise<FileSystemDirectoryHandle> {
  const parts = normalizePath(path).split("/").filter(Boolean);
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}
```

### 2.3 The opfs-worker.ts Script

This Worker script must be SELF-CONTAINED. It cannot import from other packages because it runs in a Worker context created via `new Worker(url)`. Either:
- **Option A:** Bundle it as a string constant at build time (tsup can do this)
- **Option B:** Use a Blob URL at runtime

Recommended: **Option A** — bundle during build.

```typescript
// opfs-worker.ts — runs inside dedicated Worker
// This file is bundled into a string constant by tsup

let opfsRoot: FileSystemDirectoryHandle;

// Initialize on first message
async function init() {
  opfsRoot = await navigator.storage.getDirectory();
}

// Handle requests from main thread
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
        transfer.push(buffer); // Zero-copy transfer
        break;
      }
      case "writeFile": {
        await writeFile(msg.args[0] as string, msg.args[1] as ArrayBuffer);
        result = undefined;
        break;
      }
      case "mkdir": {
        await mkdir(msg.args[0] as string, msg.args[1] as { recursive?: boolean });
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
        await rmdir(msg.args[0] as string, msg.args[1] as { recursive?: boolean });
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
      default:
        throw new Error(`Unknown FS method: ${msg.method}`);
    }

    self.postMessage(
      { __hermetic: true, ns: "fs", id: msg.id, ok: true, value: result },
      transfer
    );
  } catch (err: any) {
    // Map DOMException to POSIX-style errors
    self.postMessage({
      __hermetic: true, ns: "fs", id: msg.id,
      ok: false,
      error: mapFSError(err, msg.method, msg.args[0]),
    });
  }
};
```

**Error Mapping (DOMException → POSIX):**

```typescript
function mapFSError(err: unknown, syscall: string, path?: string) {
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
  return { name: "Error", message: String(err) };
}
```

### 2.4 Main Thread FS API (`fs.ts`)

The main-thread `HermeticFS` class wraps the Worker communication in a clean async API:

```typescript
export async function createFS(options: FSOptions = {}): Promise<HermeticFS> {
  const backend = options.backend ?? (supportsOPFS() ? "opfs" : "indexeddb");

  switch (backend) {
    case "opfs":
      return createOPFSBackend();
    case "indexeddb":
      return createIndexedDBBackend();
    case "memory":
      return createMemoryBackend();
  }
}

function supportsOPFS(): boolean {
  return typeof navigator !== "undefined"
    && "storage" in navigator
    && "getDirectory" in navigator.storage;
}

async function createOPFSBackend(): Promise<HermeticFS> {
  // Create the OPFS Worker
  const workerCode = OPFS_WORKER_SOURCE; // Bundled string constant
  const blob = new Blob([workerCode], { type: "application/javascript" });
  const worker = new Worker(URL.createObjectURL(blob));

  // Wrap in HermeticChannel for RPC
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ __hermetic_init: true, port: port2 }, [port2]);
  // ... OR use worker.onmessage directly

  return new OPFSHermeticFS(worker, port1);
}
```

### 2.5 stat() Implementation

OPFS doesn't have traditional POSIX stat. You need to synthesize it:

```typescript
async function stat(path: string): Promise<FileStat> {
  const parts = normalizePath(path).split("/").filter(Boolean);

  if (parts.length === 0) {
    // Root directory
    return { type: "directory", size: 0, mode: 0o755, atime: new Date(), mtime: new Date(), ctime: new Date() };
  }

  const parentPath = "/" + parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1];
  const parentDir = await navigateToDir(parentPath || "/");

  // Try as file first
  try {
    const fileHandle = await parentDir.getFileHandle(name);
    const accessHandle = await fileHandle.createSyncAccessHandle({ mode: "read-only" });
    try {
      const size = accessHandle.getSize();
      return { type: "file", size, mode: 0o644, atime: new Date(), mtime: new Date(), ctime: new Date() };
    } finally {
      accessHandle.close();
    }
  } catch {
    // Not a file, try as directory
    try {
      await parentDir.getDirectoryHandle(name);
      return { type: "directory", size: 0, mode: 0o755, atime: new Date(), mtime: new Date(), ctime: new Date() };
    } catch {
      throw new DOMException(`Not found: ${path}`, "NotFoundError");
    }
  }
}
```

**KNOWN LIMITATION:** OPFS does not store timestamps, permissions, or uid/gid. These must be stored in a sidecar metadata store (IndexedDB) if needed. For Phase 1, return sensible defaults. For Phase 2, add a metadata layer.

### 2.6 Memory Backend (for tests)

```typescript
// Simple Map-based FS for testing — no Workers, no async needed
class MemoryFS implements HermeticFS {
  private files = new Map<string, { type: "file" | "directory"; content?: Uint8Array }>();
  readonly backend = "memory" as const;

  constructor() {
    this.files.set("/", { type: "directory" });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const node = this.files.get(normalizePath(path));
    if (!node) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    if (node.type !== "file") throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
    return node.content!;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const normalized = normalizePath(path);
    const dir = dirname(normalized);
    if (!this.files.has(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
    const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.files.set(normalized, { type: "file", content });
  }

  // ... etc for all methods
}
```

### 2.7 Tests for @hermetic/fs

```
tests/
├── memory.test.ts          # All FS operations against memory backend
├── opfs.browser.test.ts    # OPFS backend in vitest browser mode
├── path-resolution.test.ts # normalizePath, symlink resolution
├── errors.test.ts          # ENOENT, EISDIR, ENOTEMPTY mapping
└── watch.test.ts           # FileSystemObserver + polling fallback
```

Test every operation against BOTH memory and OPFS backends. The memory backend is your ground truth — if an operation works in memory but not in OPFS, the bug is in the OPFS Worker.

---

## 3. Package: @hermetic/net

**Purpose:** MessageChannel-based HTTP routing between preview iframe and host.

**Depends on:** `@hermetic/core`

### 3.1 Files

```
packages/net/src/
├── index.ts              # Public API: createRouter, createPreview
├── types.ts              # NetOptions, ServerHandler
├── router.ts             # Host-side request router
├── shim.ts               # Fetch/XHR/WebSocket shim code (bundled as string)
├── preview.ts            # Sandbox iframe creation + port transfer
├── shims/
│   ├── fetch-shim.ts     # window.fetch override
│   ├── xhr-shim.ts       # XMLHttpRequest override
│   ├── ws-shim.ts        # WebSocket override
│   ├── location-shim.ts  # window.location + history override
│   └── cookie-shim.ts    # document.cookie virtual jar
└── streaming.ts          # Streaming response handling
```

### 3.2 Bootstrap Sequence (TIMING IS CRITICAL)

The sandbox iframe and MessageChannel setup has a specific ordering that MUST be followed:

```
1. Host creates MessageChannel → gets port1, port2
2. Host creates sandbox iframe (srcdoc with shim code)
3. Host registers router on port2 (port2.onmessage = router)
4. Host waits for iframe "load" event
5. Host transfers port1 into iframe via postMessage
6. Iframe shim receives port, stores it, starts intercepting fetch()
7. Host injects user application code into iframe
```

**Race condition warning:** If you transfer the port BEFORE the iframe's shim code has registered its `window.addEventListener("message", ...)` listener, the port transfer is LOST. The `load` event ensures the shim has executed.

```typescript
export function createPreview(options: PreviewOptions): Promise<PreviewHandle> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const router = createRouter(options.handler);

    // Router listens on port2
    port2.onmessage = (event) => router(event, port2);

    // Build shim code (bundled at build time)
    const shimCode = buildShimCode();

    // Create sandbox iframe
    const iframe = document.createElement("iframe");
    iframe.sandbox.add("allow-scripts");
    // Do NOT add allow-same-origin — that breaks the seal
    iframe.srcdoc = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy"
      content="script-src 'unsafe-inline' blob:; connect-src 'none';">
</head><body>
<script>${shimCode}</script>
</body></html>`;

    iframe.style.cssText = "border:none;width:100%;height:100%";

    iframe.addEventListener("load", () => {
      // Transfer port1 into the iframe
      iframe.contentWindow!.postMessage(
        { type: "hermetic-net-init" },
        "*",
        [port1]
      );
      resolve({
        iframe,
        port: port2,
        reload: () => { /* rebuild srcdoc */ },
        dispose: () => {
          port1.close();
          port2.close();
          iframe.remove();
        },
      });
    });

    // Append to trigger load
    (options.container ?? document.body).appendChild(iframe);
  });
}
```

### 3.3 The Shim Bundle

All shim code (`fetch-shim.ts`, `xhr-shim.ts`, etc.) must be bundled into a SINGLE string that gets injected into the iframe's `<script>` tag. These files run in the iframe context, NOT in the host.

Use tsup's `define` or a custom build step to inline these as string constants.

### 3.4 Streaming Responses

For Server-Sent Events, streaming JSON, etc., the router must handle `ReadableStream` response bodies:

```typescript
// In router.ts — detect streaming responses
if (response.body && isStreamingResponse(response)) {
  // Send metadata first
  port.postMessage({
    __hermetic: true, ns: "net", id,
    status: response.status, statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    streaming: true,
  });

  // Pipe chunks through MessageChannel
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        port.postMessage({ __hermetic: true, ns: "net", id, stream: "end" });
        break;
      }
      port.postMessage(
        { __hermetic: true, ns: "net", id, stream: "chunk", data: value.buffer },
        [value.buffer] // Transfer, not copy
      );
    }
  } catch (err) {
    port.postMessage({ __hermetic: true, ns: "net", id, stream: "error", error: String(err) });
  }
}
```

---

## 4. Package: @hermetic/vm

**Purpose:** Create isolated execution contexts (Workers) inside the sandbox iframe with capability bindings injected.

**Depends on:** `@hermetic/core`, `@hermetic/fs` (for module loading)

### 4.1 Files

```
packages/vm/src/
├── index.ts              # Public API: createVM
├── types.ts              # ContextOptions, EvalOptions
├── vm.ts                 # HermeticVM class
├── context.ts            # ExecutionContext — manages one Worker
├── bindings.ts           # Capability binding generation
├── module-loader.ts      # ES module resolution chain
└── worker-template.ts    # Template code prepended to user code
```

### 4.2 Worker Creation Inside Sandbox Iframe

**KEY INSIGHT:** The VM doesn't create Workers directly from the host page. It sends a message to the sandbox iframe, which creates the Worker inside itself. This keeps user code inside the isolation boundary.

```
Host sends "vm.createContext" request
  → MessageChannel → Sandbox iframe
  → Iframe creates new Worker(Blob URL)
  → Worker gets capability bindings, NOT raw APIs
  → Worker's postMessage goes to iframe, NOT to host
  → Iframe forwards relevant messages to host via MessageChannel
```

### 4.3 Capability Binding Template

The `worker-template.ts` generates the preamble injected before user code:

```typescript
export function generateBindings(capabilities: string[]): string {
  return `
// === HERMETIC CAPABILITY BINDINGS ===
// This code is injected before user code. User code cannot access
// raw browser APIs — only these capability-bound versions.

const __hermetic_port = /* MessagePort received during Worker init */;

// Sealed fetch — routes through MessageChannel, host audits
const fetch = async (input, init) => {
  const id = crypto.randomUUID();
  const request = new Request(input, init);
  const body = await request.arrayBuffer();
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      if (event.data?.id !== id) return;
      __hermetic_port.removeEventListener("message", handler);
      if (event.data.error) reject(new TypeError(event.data.error));
      else resolve(new Response(event.data.body, {
        status: event.data.status,
        statusText: event.data.statusText,
        headers: event.data.headers,
      }));
    };
    __hermetic_port.addEventListener("message", handler);
    __hermetic_port.postMessage({
      __hermetic: true, ns: "net", id,
      method: "fetch",
      url: request.url,
      method_: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body.byteLength > 0 ? body : null,
    });
  });
};

// Sealed console — captured and forwarded to host
const console = {
  log: (...args) => __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "log", args: args.map(String) }),
  error: (...args) => __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "error", args: args.map(String) }),
  warn: (...args) => __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "warn", args: args.map(String) }),
  info: (...args) => __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "info", args: args.map(String) }),
};

// Sealed fs — routes to HermeticFS via MessageChannel
const fs = {
  readFile: (path) => __call("fs", "readFile", [path]),
  writeFile: (path, data) => __call("fs", "writeFile", [path, data]),
  // ... etc
};

async function __call(ns, method, args) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      if (event.data?.id !== id) return;
      __hermetic_port.removeEventListener("message", handler);
      if (event.data.ok) resolve(event.data.value);
      else reject(new Error(event.data.error?.message ?? "Unknown error"));
    };
    __hermetic_port.addEventListener("message", handler);
    __hermetic_port.postMessage({ __hermetic: true, ns, id, method, args });
  });
}

// === END HERMETIC BINDINGS ===
`;
}
```

---

## 5. Package: @hermetic/dev

**Purpose:** esbuild-wasm build pipeline, HMR, live preview.

**Depends on:** `@hermetic/core`, `@hermetic/fs`, `@hermetic/net`

### 5.1 Files

```
packages/dev/src/
├── index.ts              # Public API: createDev
├── types.ts              # DevOptions, BuildResult
├── dev.ts                # HermeticDev class
├── builder.ts            # esbuild-wasm integration
├── hmr.ts                # HMR protocol + React Fast Refresh
├── plugins/
│   ├── hermetic-resolver.ts  # esbuild plugin: resolve imports against HermeticFS
│   ├── css-modules.ts        # CSS module handling
│   └── jsx-transform.ts      # JSX/TSX transform config
└── templates/
    ├── html-template.ts      # Default HTML wrapper for preview
    └── hmr-client.ts         # HMR client injected into preview
```

### 5.2 esbuild-wasm Integration

esbuild-wasm runs in the browser. The key challenge: esbuild's filesystem plugin API expects to resolve and load files. We need a custom plugin that reads from HermeticFS:

```typescript
import * as esbuild from "esbuild-wasm";

// Initialize esbuild-wasm ONCE (it loads the Wasm binary)
let initialized = false;
async function ensureEsbuild() {
  if (initialized) return;
  await esbuild.initialize({
    wasmURL: "https://esm.sh/esbuild-wasm@0.21.0/esbuild.wasm",
    // OR bundle locally
  });
  initialized = true;
}

// Custom plugin that resolves from HermeticFS
function hermeticPlugin(fs: HermeticFS): esbuild.Plugin {
  return {
    name: "hermetic-fs",
    setup(build) {
      // Resolve bare specifiers via esm.sh
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        // npm specifier → CDN URL
        return { path: `https://esm.sh/${args.path}`, external: true };
      });

      // Resolve relative imports against HermeticFS
      build.onResolve({ filter: /^\./ }, (args) => {
        const resolved = resolvePath(dirname(args.importer), args.path);
        return { path: resolved, namespace: "hermetic" };
      });

      // Load files from HermeticFS
      build.onLoad({ filter: /.*/, namespace: "hermetic" }, async (args) => {
        const content = await fs.readFile(args.path);
        const text = new TextDecoder().decode(content);
        const loader = getLoader(args.path); // .ts → "ts", .tsx → "tsx", .css → "css"
        return { contents: text, loader };
      });
    },
  };
}
```

### 5.3 HMR Implementation

HMR requires:
1. Watch files for changes (HermeticFS.watch)
2. Rebuild only affected modules (esbuild incremental)
3. Send updated module code to preview iframe
4. Preview applies update via module hot-swap or React Fast Refresh

The HMR client is injected into the preview iframe alongside the shim code. It listens for update messages and applies them.

---

## 6. Package: @hermetic/pm

**Purpose:** npm package resolution and installation.

**Depends on:** `@hermetic/core`, `@hermetic/fs`

### 6.1 Files

```
packages/pm/src/
├── index.ts              # Public API: createPM
├── types.ts              # Packument, VersionMetadata, etc.
├── pm.ts                 # HermeticPM class
├── registry.ts           # npm registry HTTP client
├── resolver.ts           # Dependency tree resolution + semver
├── tarball.ts            # Tarball fetch + gzip decompress + tar parse
├── tar-parser.ts         # Pure JS tar parser (~200 lines)
├── cache.ts              # IndexedDB package cache
├── cdn.ts                # esm.sh CDN resolution
└── lockfile.ts           # package-lock.json v3 read/write
```

### 6.2 Tar Parser

Implement from POSIX.1-2001 spec. A tar file is a sequence of 512-byte blocks:

```typescript
// tar-parser.ts — Pure JS tar extraction
// Tar header: 512 bytes, fields at fixed offsets

interface TarEntry {
  name: string;      // bytes 0-99
  mode: number;      // bytes 100-107 (octal)
  size: number;      // bytes 124-135 (octal)
  type: string;      // byte 156: '0'=file, '5'=directory
  content: Uint8Array;
}

export function* parseTar(data: Uint8Array): Generator<TarEntry> {
  let offset = 0;
  while (offset < data.length - 512) {
    const header = data.subarray(offset, offset + 512);

    // Empty block = end of archive
    if (header.every((b) => b === 0)) break;

    const name = readString(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156]);

    // Check for UStar prefix (bytes 345-500)
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += 512; // Past header

    // File content follows header, padded to 512-byte boundary
    const content = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    // Strip "package/" prefix (npm tarballs always have this)
    const cleanName = fullName.replace(/^package\//, "");

    if (type === "0" || type === "\0") {
      yield { name: cleanName, mode, size, type: "file", content };
    } else if (type === "5") {
      yield { name: cleanName, mode, size, type: "directory", content: new Uint8Array(0) };
    }
  }
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  const actualEnd = end === -1 || end > offset + length ? offset + length : end;
  return new TextDecoder().decode(buf.subarray(offset, actualEnd));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const str = readString(buf, offset, length).trim();
  return parseInt(str, 8) || 0;
}
```

### 6.3 Tarball Pipeline (Streaming)

```typescript
async function extractPackage(tarballUrl: string, targetDir: string, fs: HermeticFS): Promise<void> {
  const response = await fetch(tarballUrl);
  if (!response.ok) throw new Error(`Failed to fetch: ${tarballUrl}`);

  // Decompress gzip → tar bytes
  const decompressed = response.body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate chunks
  const tarData = concatUint8Arrays(chunks);

  // Parse tar and write to FS
  for (const entry of parseTar(tarData)) {
    const fullPath = joinPath(targetDir, entry.name);
    if (entry.type === "directory") {
      await fs.mkdir(fullPath, { recursive: true });
    } else {
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, entry.content);
    }
  }
}
```

---

## 7. Package: @hermetic/proc

**Purpose:** Web Worker process model with stdin/stdout/stderr via Transferable Streams.

**Depends on:** `@hermetic/core`, `@hermetic/fs`, `@hermetic/vm`

### 7.1 Key Implementation Detail: Transferable Streams for Pipes

When piping stdout of Process A into stdin of Process B, use `ReadableStream` transfer:

```typescript
// Create a pipe between two processes
function createPipe(): { reader: ReadableStream<Uint8Array>; writer: WritableStream<Uint8Array> } {
  const { readable, writable } = new TransformStream<Uint8Array>();
  return { reader: readable, writer: writable };
}

// Transfer the readable end to Process B's Worker
const pipe = createPipe();
processA.stdout = pipe.writer;
// Transfer pipe.reader to Process B's Worker via postMessage
processB.worker.postMessage(
  { type: "stdin", stream: pipe.reader },
  [pipe.reader] // Transfer ownership
);
```

---

## 8. Package: @hermetic/shell

**Purpose:** Shell command parser and interpreter.

**Depends on:** `@hermetic/core`, `@hermetic/fs`, `@hermetic/proc`, `@hermetic/pm`

### 8.1 Parser Architecture

The shell parser should handle the syntax defined in the spec. Implement as a recursive descent parser:

```
ShellLine     → Pipeline (("&&" | "||" | ";") Pipeline)*
Pipeline      → Command ("|" Command)*
Command       → SimpleCommand | Subshell
SimpleCommand → Assignment* Word+ Redirect*
Assignment    → NAME "=" Word
Redirect      → (">" | ">>" | "<" | "2>&1") Word
Word          → QuotedString | Variable | Glob | RawString
Variable      → "$" NAME | "${" NAME (":-" Word)? "}"
Subshell      → "$(" ShellLine ")" | "`" ShellLine "`"
```

### 8.2 Glob Implementation

Use a simple glob-to-regex converter:
```typescript
function globToRegex(pattern: string): RegExp {
  let regex = "^";
  for (const char of pattern) {
    switch (char) {
      case "*": regex += ".*"; break;
      case "?": regex += "."; break;
      case ".": regex += "\\."; break;
      default: regex += char;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
```

For `**` (recursive glob), expand by walking the directory tree.

---

## 9. Package: @hermetic/runtime

**Purpose:** Facade that wires all subsystems together.

**Depends on:** ALL other packages.

### 9.1 The create() Factory

```typescript
export async function create(options?: RuntimeOptions): Promise<Hermetic> {
  const disposables = new DisposableStore();

  const fs = disposables.add(await createFS(options?.fs));
  const net = disposables.add(createNet());
  const vm = disposables.add(createVM({ fs }));
  const pm = disposables.add(createPM({ fs }));
  const proc = disposables.add(createProc({ fs, vm }));
  const shell = disposables.add(createShell({ fs, proc, pm }));
  const dev = disposables.add(createDev({ fs, net, vm }));

  return {
    fs, net, vm, pm, proc, shell, dev,
    dispose: () => disposables.dispose(),
  };
}
```

---

## 10. Browser Compatibility Matrix

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| OPFS | ✅ 86+ | ✅ 111+ | ✅ 15.2+ | ✅ 86+ |
| OPFS Sync Access | ✅ 102+ | ✅ 111+ | ✅ 15.2+ | ✅ 102+ |
| `readwrite-unsafe` | ✅ 121+ | ❌ | ❌ | ✅ 121+ |
| FileSystemObserver | ✅ 129+ | ❌ | ❌ | ✅ 129+ |
| MessageChannel | ✅ 2+ | ✅ 41+ | ✅ 5+ | ✅ 12+ |
| Transferable Streams | ✅ 87+ | ✅ 102+ | ✅ 14.1+ | ✅ 87+ |
| DecompressionStream | ✅ 80+ | ✅ 113+ | ✅ 16.4+ | ✅ 80+ |
| Sandbox iframe | ✅ 4+ | ✅ 17+ | ✅ 5+ | ✅ 12+ |
| Web Workers (Blob URL) | ✅ 5+ | ✅ 4+ | ✅ 5+ | ✅ 12+ |
| crypto.randomUUID | ✅ 92+ | ✅ 95+ | ✅ 15.4+ | ✅ 92+ |
| JSPI (Wasm) | ✅ 126+ | 🔄 impl | ❌ | ✅ 126+ |
| ShadowRealm | ❌ (wip) | ❌ (wip) | 🔄 JSC | ❌ (wip) |

**Minimum viable browser:** Chrome 102+ / Firefox 111+ / Safari 15.2+ / Edge 102+

Everything in Phase 1 works across all modern browsers. `readwrite-unsafe`, FileSystemObserver, JSPI, and ShadowRealm are progressive enhancements — detect and use when available, fall back gracefully.

---

## 11. Error Handling Philosophy

Every cross-boundary call can fail. The error handling chain is:

```
User code throws → Worker catches → serializes to SerializedError
  → postMessage to iframe → iframe forwards to host via MessageChannel
  → HermeticChannel deserializes → caller gets proper Error with code/path/syscall
```

**Rules:**
1. NEVER let an unhandled rejection crash a Worker silently. Wrap ALL Worker message handlers in try/catch.
2. ALWAYS include `code` on filesystem errors (`ENOENT`, `EISDIR`, etc.)
3. ALWAYS include `path` and `syscall` on filesystem errors for debugging.
4. NEVER expose internal stack traces in production — only in development mode.
5. Timeout errors must be distinguishable from other errors (`error.name === "TIMEOUT"`).

---

## 12. Performance Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| FS readFile (1KB) | < 1ms | OPFS sync handle + transfer |
| FS writeFile (1KB) | < 2ms | OPFS sync handle + flush |
| FS readdir (100 entries) | < 5ms | |
| MessageChannel round-trip | < 0.5ms | Structured clone overhead |
| npm install (1 package, cached) | < 100ms | IndexedDB cache hit |
| npm install (1 package, network) | < 3s | Depends on network |
| esbuild build (100 files) | < 2s | esbuild-wasm is fast |
| HMR update | < 200ms | File change → preview update |
| Preview iframe bootstrap | < 500ms | Iframe + shim + port transfer |

---

## 13. Security Checklist

Before shipping, verify ALL of these:

- [ ] Sandbox iframe has NO `allow-same-origin` in sandbox attribute
- [ ] Sandbox iframe CSP blocks `connect-src` (no direct network from sandbox)
- [ ] Workers inside sandbox are created from Blob URLs (no external script load)
- [ ] User code cannot access `window.parent`, `window.top`, or `window.opener`
- [ ] User code cannot read host page cookies, localStorage, or sessionStorage
- [ ] User code cannot navigate the host page
- [ ] User code can only `fetch()` through the capability binding (which the host audits)
- [ ] OPFS handles are never exposed to user code
- [ ] Worker termination actually stops execution (test infinite loops)
- [ ] No Service Workers are registered by any Hermetic code
- [ ] No cross-origin iframes are created by any Hermetic code
- [ ] All MessageChannel messages are branded (`__hermetic: true`) to prevent spoofing from other postMessage sources

---

## 14. CC Kickoff Checklist

When starting implementation with Claude Code, provide:

1. This file (`hermetic-cc-plan.md`) — the HOW
2. The spec file (`hermetic-spec.md`) — the WHAT
3. Start with: "Read hermetic-spec.md and hermetic-cc-plan.md, then implement @hermetic/core following section 1 of the CC plan. Create the monorepo structure from section 0 first."
4. After core is done: "Implement @hermetic/fs following section 2 of the CC plan. Start with the memory backend, then OPFS."
5. After fs: "Implement @hermetic/net following section 3. Pay careful attention to the bootstrap sequence timing."
6. Continue sequentially through each package.

**Keep CC prompts focused on ONE package at a time.** Do not ask CC to implement multiple packages in one session. Each package builds on the last and needs testing before proceeding.

**After each package, verify:**
- `pnpm build` succeeds
- `pnpm test` passes
- TypeScript has no errors (`pnpm typecheck`)
- The package can be imported independently
