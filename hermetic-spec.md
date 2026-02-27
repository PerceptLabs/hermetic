# Hermetic: Implementation Specification

**Version:** 1.0.0-spec
**License:** MIT
**Status:** Ready for Implementation
**Name Origin:** Hermetic — (1) hermetically sealed isolation, (2) Hermetic tradition ("as above, so below" — the sandbox mirrors a real OS), (3) hermetic builds — already an engineering term for fully isolated, reproducible execution.

---

## 0. Executive Summary

Hermetic is a MIT-licensed browser-native runtime. It provides hermetically sealed JavaScript execution — filesystem, processes, packages, shell, networking, dev server — entirely inside a browser tab using standard web platform APIs.

It exists because today there is exactly one production-grade browser runtime (WebContainers), it is proprietary, it is patented, and every browser-based IDE, educational platform, and AI coding assistant depends on technology one entity controls. Infrastructure should be open.

Hermetic uses modern browser primitives (OPFS sync handles, MessageChannel, Transferable Streams, FileSystemObserver) that didn't exist when WebContainers was designed. These primitives make WebContainers' patented cross-origin relay mechanism unnecessary. Hermetic is not a clone — it's a clean-room implementation built on the platform WebContainers wished it had.

**This document is the complete implementation specification.** It is designed to be handed directly to an AI coding agent (Claude Code) as the authoritative source for building Hermetic from scratch.

---

## 1. Design Principles

### 1.1 Composable, Not Monolithic

Every subsystem is an independent package with its own API surface. Consumers import what they need. `@hermetic/fs` works without `@hermetic/vm`. `@hermetic/net` works without `@hermetic/shell`. The full runtime is one possible assembly. There are many others.

### 1.2 Web Standards First

Where a web API exists, use it. Where a web spec defines behavior, follow it. Hermetic is an orchestration layer over web platform capabilities, not a replacement for them.

### 1.3 Modern Runtimes Over Legacy

Target Deno/Bun-style web-standard APIs, not Node.js legacy APIs. `fetch()` over `http.request()`. `Response` over `res.end()`. `ReadableStream` over `stream.Readable`. Node.js compatibility is opt-in via polyfill packages, not built into core.

### 1.4 Explicit Over Magic

Every operation is observable. Filesystem writes emit events. Process spawns are logged. Network requests are traceable. No hidden state machines. No implicit side effects.

### 1.5 Honest Boundaries

Document what Hermetic can't do as prominently as what it can. Real TCP? No. Real child processes with signals? No. Native C extensions? No. State limitations clearly and provide escape hatches to real runtimes when browser-native isn't enough.

### 1.6 Clean-Room Engineering

Every line of code traces to public specifications, public API documentation, or original engineering. Zero reference to proprietary implementations. Zero code derived from restrictively-licensed projects.

### 1.7 Hermetic Sealing

User code never runs on the host page. All execution happens inside sandboxed iframes and dedicated Workers. Communication only through MessageChannel. Capabilities are explicitly bound, never implicitly available. Code inside the seal mirrors a real OS but cannot escape it.

---

## 2. Architecture Overview

### 2.1 Baseline Architecture (Set in Stone)

This is the production architecture. It uses only APIs that work TODAY in all modern browsers.

```
┌─────────────────────────────────────────────────────┐
│  HOST PAGE (IDE / educational platform / any host)   │
│                                                       │
│  HermeticHost — orchestrator, NEVER runs user code    │
│  ├── HermeticFS     (OPFS sync handles in Worker)     │
│  ├── HermeticPM     (npm resolution + streaming)      │
│  └── HermeticDev    (HMR, FileSystemObserver)         │
└──────────────┬────────────────────────────────────────┘
               │ MessageChannel (ONLY communication path)
               │ + Transferable Streams (zero-copy data)
┌──────────────▼────────────────────────────────────────┐
│  SANDBOX IFRAME (sandbox="allow-scripts", srcdoc)      │
│  Opaque origin — null origin, no parent access         │
│                                                         │
│  HermeticRuntime — WinterTC-compatible API layer        │
│  ├── fetch()     → routed through MessageChannel        │
│  ├── fs.*        → routed to HermeticFS Worker          │
│  ├── console.*   → captured + forwarded to host         │
│  ├── setTimeout  → native (already available)           │
│  ├── crypto      → native (already available)           │
│  ├── Streams     → native + transferable                │
│  └── process.*   → shimmed from HermeticProc            │
│                                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │  DEDICATED WORKER (per "process")                  │ │
│  │  Created via Blob URL from user code               │ │
│  │  Capability bindings injected at creation           │ │
│  │  CSP: no external fetch, no eval                   │ │
│  │  Only postMessage out to sandbox iframe             │ │
│  │  User code runs HERE — V8 JIT, full speed          │ │
│  └───────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────┐ │
│  │  DEDICATED WORKER (another "process")              │ │
│  │  Same isolation model                              │ │
│  │  Transferable Streams between workers              │ │
│  │  = pipe stdout → stdin, zero-copy                  │ │
│  └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Isolation Layers (Outside In)

1. **Sandbox iframe** — opaque origin via `sandbox="allow-scripts"` (no `allow-same-origin`). Cannot access parent DOM, cookies, storage, or any parent-origin resources. This is the perimeter.

2. **CSP on the iframe** — `script-src 'self' blob:; connect-src 'none'` — Workers inside cannot fetch external URLs directly. All network goes through capability bindings.

3. **Dedicated Worker per process** — separate thread, separate global, can be terminated via `Worker.terminate()`. Created from Blob URL so no external script fetch needed.

4. **Capability bindings** — Worker does NOT get raw `fetch()`. It gets `HermeticBinding.fetch()` which routes through MessageChannel to the host, which audits and fulfills. Borrowed from Cloudflare workerd's model.

5. **Transferable Streams** — zero-copy data flow between Workers (process piping) and between sandbox and host (file I/O, network responses).

### 2.3 Four-Tier Isolation Model (Progressive Enhancement)

```
Tier 0: ShadowRealm (FUTURE — when native support ships)
  - V8 JIT speed, synchronous, isolated global
  - Callable boundary = only primitives + wrapped functions cross
  - Progressive enhancement: detect + use, fall back to Tier 1
  - Status: Stage 2.7 TC39, implemented in JSC, WIP V8/SpiderMonkey

Tier 1: Sandboxed iframe + Worker (TODAY'S DEFAULT)
  - Opaque origin iframe → Dedicated Worker inside
  - V8 JIT speed, origin-isolated
  - Communication via MessageChannel + Transferable Streams
  - Works everywhere, no special headers needed

Tier 2: Sandboxed iframe + COI Worker (WHEN HEADERS AVAILABLE)
  - Everything from Tier 1
  - Plus SharedArrayBuffer (synchronous cross-thread comms)
  - Plus OS-level process isolation
  - Enables Atomics.wait patterns for sync FS from main thread

Tier 3: txiki.js Wasm + JSPI (MAXIMUM ISOLATION)
  - Wasm linear memory sandbox
  - JSPI bridges sync C code to async browser APIs (no Asyncify)
  - CPU time limits, memory limits
  - For: untrusted plugins, sandboxed execution, resource caps
```

Implementation note: Tier 1 is the ONLY tier to implement first. Tiers 0, 2, 3 are documented as future enhancement paths with clear feature-detection gates.

### 2.4 Package Structure

```
@hermetic/fs           — Virtual filesystem (OPFS + IndexedDB + memory)
@hermetic/vm           — JavaScript execution engine (V8 native + QuickJS Wasm)
@hermetic/proc         — Process model (Web Workers)
@hermetic/pm           — Package manager (npm registry client)
@hermetic/shell        — Shell interpreter
@hermetic/net          — Networking layer (MessageChannel fetch routing)
@hermetic/dev          — Dev server & preview (esbuild-wasm + HMR)
@hermetic/runtime      — Full runtime (depends on all above)
@hermetic/core         — Shared types, utilities, MessageChannel protocol
```

### 2.5 Technology Stack

| Technology | Role | License |
|-----------|------|---------|
| OPFS (Origin Private File System) | Primary filesystem backend | Web Standard |
| `createSyncAccessHandle()` | Synchronous file I/O in Workers | Web Standard |
| `readwrite-unsafe` mode | Concurrent OPFS reads (Chrome 121+) | Web Standard |
| FileSystemObserver | Native file watching (Chrome 129+) | Web Standard |
| MessageChannel | All cross-context communication | Web Standard |
| Transferable Streams | Zero-copy data transfer | Web Standard |
| JSPI (Wasm) | Sync C → async JS bridge (Phase 4) | Web Standard |
| esbuild-wasm | TypeScript/JSX compilation, bundling | MIT |
| QuickJS-ng (Wasm) | Isolated JS execution with memory limits | MIT |
| txiki.js (Wasm) | Full runtime with event loop (future) | MIT |
| isomorphic-git | Git operations in browser | MIT |
| esm.sh | ESM CDN for npm package resolution | — |

---

## 3. Subsystem 1: HermeticFS — Virtual Filesystem

### 3.1 Purpose

POSIX-like filesystem in the browser. Files, directories, symlinks, permissions, timestamps, watching. Persists across page reloads. Supports synchronous operations from Web Workers.

### 3.2 Storage Backends

#### 3.2.1 OPFS (Primary — Production)

The Origin Private File System. Available in all modern browsers since early 2023.

- **Synchronous access** from Workers via `createSyncAccessHandle()`
- **Persistent** across page reloads and browser restarts
- **2-4x faster** than IndexedDB for file operations
- **No Cross-Origin Isolation headers needed** for the async path; sync handles only require a dedicated Worker
- **`readwrite-unsafe` mode** (Chrome 121+) enables concurrent read access from multiple Workers
- **FileSystemObserver** (Chrome 129+) provides native file watching on OPFS — no polling

This alone eliminates WebContainers' biggest architectural constraint: they built their entire FS on SharedArrayBuffer + custom memory layout because OPFS sync handles didn't exist yet.

```
Browser API: navigator.storage.getDirectory()
├── Returns FileSystemDirectoryHandle (root)
├── createSyncAccessHandle({ mode: "readwrite" }) for sync Worker I/O
├── Supports: read, write, truncate, flush, getSize
└── Spec: https://fs.spec.whatwg.org/
```

#### 3.2.2 IndexedDB (Fallback)

For environments where OPFS isn't available or when the main thread needs filesystem access.

Schema:
```typescript
// Store: "files", Key: "/path/to/file"
interface FileNode {
  type: "file" | "directory" | "symlink";
  content: Uint8Array | null;
  mode: number;
  uid: number;
  gid: number;
  atime: number;
  mtime: number;
  ctime: number;
  target: string | null; // symlink target
}
```

#### 3.2.3 In-Memory (Testing / Ephemeral)

Plain JavaScript `Map<string, FileNode>`. No persistence. Fast. For tests, temporary operations, disposable environments.

### 3.3 API Surface

```typescript
interface HermeticFS {
  // Core operations
  readFile(path: string): Promise<Uint8Array>;
  readFileSync(path: string): Uint8Array;  // Worker only (OPFS)
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  writeFileSync(path: string, data: Uint8Array | string): void;

  // Directory operations
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  // File metadata
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;

  // Links
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;

  // File management
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;

  // Watching (uses FileSystemObserver when available, falls back to polling)
  watch(path: string, callback: WatchCallback): Disposable;

  // Bulk operations
  snapshot(): Promise<FileSystemSnapshot>;
  restore(snapshot: FileSystemSnapshot): Promise<void>;

  // Introspection
  backend: "opfs" | "indexeddb" | "memory";
  usage(): Promise<{ used: number; available: number }>;
}

interface FileStat {
  type: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
}

type WatchCallback = (event: "create" | "modify" | "delete", path: string) => void;
```

### 3.4 Path Resolution

Standard POSIX path resolution. `/` is root. `.` is current directory. `..` is parent. Symlinks resolved transitively (max 40 hops, matching Linux default). Path normalization removes double slashes, trailing slashes, resolves `.`/`..`.

### 3.5 Layered Filesystem (Union Mount)

```
Layer 3 (top):  In-memory overlay  ← writes go here
Layer 2:        npm packages (read-only, populated by HermeticPM)
Layer 1:        Project files (OPFS, persistent)
Layer 0 (base): System files (bundled, read-only)
```

Reads traverse top-down, first match wins. Writes always go to top layer. Copy-on-write: base project never modified.

### 3.6 File Watching Implementation

```typescript
// Progressive enhancement for file watching
function createWatcher(handle: FileSystemDirectoryHandle, callback: WatchCallback): Disposable {
  if ('FileSystemObserver' in globalThis) {
    // Native — Chrome 129+, no polling, efficient
    const observer = new FileSystemObserver((records) => {
      for (const record of records) {
        callback(mapEventType(record.type), resolveRelativePath(record));
      }
    });
    observer.observe(handle, { recursive: true });
    return { dispose: () => observer.disconnect() };
  } else {
    // Fallback — poll at 500ms interval
    return createPollingWatcher(handle, callback, 500);
  }
}
```

### 3.7 Implementation Notes

- OPFS Worker should be a dedicated Web Worker that holds sync access handles open for the session
- Main thread communicates with FS Worker via MessageChannel, never directly touches OPFS
- For git integration: isomorphic-git (MIT) can use HermeticFS as its filesystem backend
- For concurrent reads: use `createSyncAccessHandle({ mode: "read-only" })` when available, fall back to `readwrite-unsafe` on Chrome

---

## 4. Subsystem 2: HermeticVM — JavaScript Execution Engine

### 4.1 Purpose

Execute JavaScript and TypeScript in the browser. Provide isolated execution contexts with configurable globals, module loading, and resource limits. Support multiple engine backends.

### 4.2 Engine Tiers

#### 4.2.1 Browser-Native V8 (Default — Fast Path)

Run code directly in the browser's V8 engine via Dedicated Workers created from Blob URLs inside the sandbox iframe.

**Advantages:** Full V8 JIT speed, all Web APIs available, zero overhead.
**Disadvantages:** No memory isolation from other code in same Worker, no resource limits beyond Worker termination.
**Use when:** Building React apps, running esbuild, any code that doesn't need byte-level sandboxing.

#### 4.2.2 QuickJS-ng Wasm (Isolation Tier)

QuickJS-ng compiled to WebAssembly. ~400KB gzipped. Full ES2023 support.

**Advantages:** Complete Wasm linear memory isolation, resource limits (memory, execution time, stack depth), deterministic, MIT licensed.
**Disadvantages:** Slower than V8 (no JIT), no event loop — every API must be injected via host bindings.
**Use when:** Running untrusted code, enforcing resource limits, plugin sandboxing.

#### 4.2.3 txiki.js Wasm (Full Runtime — Future)

txiki.js compiled to WebAssembly via Emscripten. Complete runtime with QuickJS-ng engine + libuv event loop + curl HTTP client. ~2-5MB gzipped.

Uses JSPI (JavaScript Promise Integration, Phase 4) to bridge synchronous C code to async browser APIs without Asyncify bloat:
```
libuv fs operations    → shimmed to HermeticFS (OPFS)
libuv TCP/UDP          → shimmed to HermeticNet (MessageChannel)
libuv child_process    → shimmed to HermeticProc (Web Workers)
curl HTTP client       → shimmed to browser fetch()
libuv timers           → shimmed to setTimeout/setInterval
```

**Incremental loading strategy:** Ship QuickJS-ng core immediately (~400KB). Lazy-load full txiki.js Wasm when server-side features are first used. Frontend-only users never pay the cost.

#### 4.2.4 Engine Selection Matrix

| Need | Engine | Why |
|------|--------|-----|
| React app, esbuild, general dev | Browser V8 (Worker) | Fast, all APIs available |
| Untrusted code, plugins, sandbox | QuickJS-ng Wasm | Memory isolation, resource limits |
| Server-side code in browser | txiki.js Wasm (future) | Full runtime with event loop |

### 4.3 API Surface

```typescript
interface HermeticVM {
  eval(code: string, options?: EvalOptions): Promise<unknown>;
  createContext(options?: ContextOptions): ExecutionContext;
}

interface ContextOptions {
  engine: "native" | "quickjs" | "txiki";  // default: "native"
  globals?: Record<string, unknown>;         // injected into context
  timeout?: number;         // ms — quickjs and txiki only
  memoryLimit?: number;     // bytes — quickjs and txiki only
  moduleLoader?: ModuleLoader;
}

interface ExecutionContext {
  eval(code: string): Promise<unknown>;
  callFunction(name: string, ...args: unknown[]): Promise<unknown>;
  getGlobal(name: string): unknown;
  setGlobal(name: string, value: unknown): void;
  dispose(): void;
}
```

### 4.4 Capability Bindings (Cloudflare Model)

Instead of giving user code raw browser APIs, inject capability-bound wrappers:

```typescript
// What user code SEES inside the Worker:
globalThis.fetch = HermeticBinding.fetch;    // routes through MessageChannel
globalThis.console = HermeticBinding.console; // captured + forwarded
globalThis.fs = HermeticBinding.fs;           // routes to HermeticFS Worker

// What the binding DOES:
class HermeticBinding {
  static fetch(url: string, init?: RequestInit): Promise<Response> {
    // Serialize request → postMessage to host via MessageChannel
    // Host audits URL, applies policies, fulfills request
    // Response serialized back through MessageChannel
    return sendRequest({ type: "fetch", url, init });
  }
}
```

The host maintains an audit log of every capability invocation. Code inside the seal cannot bypass the bindings because it has no access to the raw APIs — the sandbox iframe's CSP blocks direct network access, and the Worker was created from a Blob URL with only the bindings injected.

### 4.5 Module Loading

```
import { serve } from "https://deno.land/std/http/server.ts"
  → HermeticFS lookup → if not cached, fetch from URL → cache → return

import { Hono } from "npm:hono"
  → HermeticPM resolution → esm.sh CDN or local node_modules → return

import "./App.tsx"
  → HermeticFS readFile → esbuild-wasm transpile → return compiled JS
```

TypeScript/JSX transpiled on-the-fly via esbuild-wasm (MIT).

---

## 5. Subsystem 3: HermeticProc — Process Model

### 5.1 Purpose

Simulate a process tree using Web Workers. Each "process" is a Worker running inside the sandbox iframe with its own filesystem view, environment variables, and stdio streams.

### 5.2 Architecture

```
Sandbox iframe (HermeticProc manager)
  │
  ├── Worker 1 (PID 1): init process
  │     ├── Capability bindings
  │     ├── HermeticFS mount (via MessageChannel to FS Worker)
  │     └── stdin/stdout/stderr (Transferable Streams)
  │
  ├── Worker 2 (PID 2): spawned by PID 1
  │     ├── Capability bindings
  │     ├── HermeticFS mount (shared OPFS root)
  │     └── stdin/stdout/stderr (Transferable Streams)
  │
  └── Worker 3 (PID 3): spawned by PID 2
        ├── Capability bindings
        ├── HermeticFS mount
        └── stdin/stdout/stderr (Transferable Streams)
```

### 5.3 Process Table

```typescript
interface Process {
  pid: number;
  ppid: number;
  worker: Worker;
  command: string;
  args: string[];
  env: Map<string, string>;
  cwd: string;
  status: "running" | "stopped" | "terminated";
  exitCode: number | null;
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}
```

### 5.4 API Surface

```typescript
interface HermeticProc {
  spawn(command: string, args: string[], options?: SpawnOptions): Process;
  exec(command: string): Promise<ExecResult>;
  kill(pid: number, signal?: string): void;
  list(): Process[];
  waitpid(pid: number): Promise<number>;
}

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "pipe" | "inherit" | ReadableStream;
  stdout?: "pipe" | "inherit" | WritableStream;
  stderr?: "pipe" | "inherit" | WritableStream;
}
```

### 5.5 Inter-Process Communication

1. **Pipes** — stdout of one process wired to stdin of another via Transferable Streams (zero-copy)
2. **Shared filesystem** — processes read/write the same HermeticFS
3. **MessageChannel** — direct port-to-port for internal coordination

No shared memory between Workers unless explicitly configured.

### 5.6 Documented Limitations

| Real Process Feature | Support | Notes |
|---------------------|---------|-------|
| fork() | ❌ | Workers can't clone themselves |
| exec() | ✅ Simulated | Terminates Worker, spawns new one |
| Signals (SIGTERM) | ⚠️ Partial | `terminate()` for KILL, message for TERM |
| exit() | ✅ | Worker posts exit code, terminates |
| pipe() | ✅ | Transferable ReadableStream/WritableStream pairs |
| Process groups | ❌ | Flat process tree |
| setuid/setgid | ❌ | No real users in browser |

---

## 6. Subsystem 4: HermeticPM — Package Manager

### 6.1 Purpose

Resolve and install npm packages entirely in the browser. Fetch metadata from npm registry, resolve dependency trees, download tarballs, extract to HermeticFS.

### 6.2 Resolution Strategy

#### 6.2.1 CDN-First (Fast Path — Default)

For browser-targeted code, use esm.sh to skip local installation entirely:

```
import { Hono } from "npm:hono"
  → Rewrite to: https://esm.sh/hono@4.6.1
  → Browser fetches pre-bundled ESM
  → Zero installation, zero node_modules
```

Covers ~80% of npm ecosystem. Fails for: native bindings, complex postinstall scripts.

#### 6.2.2 Full Install (Compatibility Path)

```
npm install express
  → GET https://registry.npmjs.org/express (packument)
  → Resolve dependency tree (express → accepts → mime-types → ...)
  → Fetch tarballs for each package
  → Extract to HermeticFS: /node_modules/express/...
  → Write package-lock.json
```

### 6.3 Registry Client

```typescript
interface RegistryClient {
  getPackument(name: string): Promise<Packument>;
  getVersion(name: string, version: string): Promise<VersionMetadata>;
  fetchTarball(url: string): Promise<Uint8Array>;
  resolveVersion(name: string, range: string): Promise<string>;
}
```

### 6.4 Tarball Extraction Pipeline

```
Uint8Array (tarball)
  → DecompressionStream("gzip")   // Web API, all modern browsers
  → tar parser (POSIX.1-2001 format, ~200 lines)
  → HermeticFS.writeFile() for each entry
```

Use Transferable Streams to pipe tarball data directly from fetch into the FS Worker — no buffering the whole tarball in memory.

### 6.5 Cache

```typescript
// IndexedDB cache for downloaded packages
// Key: "{package}@{version}"
// Value: { tarball: Uint8Array, integrity: string, fetchedAt: number }
```

Cache-first strategy: if package exists with matching integrity, skip network. Repeat installs near-instant.

### 6.6 Lockfile

Support `package-lock.json` v3 format. When lockfile exists, skip resolution — fetch exact versions at exact URLs with integrity verification.

---

## 7. Subsystem 5: HermeticShell — Shell Interpreter

### 7.1 Purpose

Interpret shell commands and manage the virtual environment. Practical subset of bash covering developer workflows, not a full bash clone.

### 7.2 Supported Syntax

```bash
command arg1 arg2              # Commands
command1 | command2            # Pipes
command > file.txt             # Redirects (>, >>, <, 2>&1)
command &                      # Background
command1 && command2           # AND chain
command1 || command2           # OR chain
command1 ; command2            # Sequential
export FOO=bar                 # Variables
echo $FOO ${FOO:-default}     # Variable expansion
$(command)                     # Subshells
ls *.ts                        # Globs
```

### 7.3 Built-in Commands

| Command | Implementation |
|---------|---------------|
| `cd`, `pwd` | Change/print working directory |
| `ls`, `cat`, `head`, `tail` | File reading via HermeticFS |
| `echo`, `printf` | Print to stdout |
| `mkdir`, `rm`, `cp`, `mv`, `touch` | File management via HermeticFS |
| `chmod` | Mode bits |
| `grep`, `find`, `wc`, `sort`, `uniq` | Text processing (JS RegExp) |
| `env`, `export`, `which` | Environment management |
| `clear`, `exit` | Terminal control |

### 7.4 Known Executables

| Command | Handling |
|---------|----------|
| `node script.js` | HermeticVM.eval() with Node shim |
| `deno run script.ts` | HermeticVM.eval() with Deno shim |
| `npm install` | HermeticPM.install() |
| `npm run script` | Resolve from package.json, execute |
| `npx command` | HermeticPM.exec() |
| `esbuild ...` | esbuild-wasm invocation |
| `git ...` | isomorphic-git operations |

### 7.5 API Surface

```typescript
interface HermeticShell {
  execute(command: string): Promise<ExecResult>;
  registerCommand(name: string, handler: CommandHandler): void;
  setEnv(key: string, value: string): void;
  getEnv(key: string): string | undefined;
  cwd(): string;
  cd(path: string): void;
  pipe(terminal: TerminalEmulator): void;
}

type CommandHandler = (args: string[], context: {
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  env: Map<string, string>;
  cwd: string;
  fs: HermeticFS;
}) => Promise<number>; // exit code
```

---

## 8. Subsystem 6: HermeticNet — Networking Layer

### 8.1 Purpose

Route HTTP requests between browser contexts using standard MessageChannel API. NO cross-origin relay. NO Service Worker on a separate domain. NO patented mechanisms.

### 8.2 Architecture

```
┌────────────────────────────────────────────────────────┐
│ Preview iframe (sandbox="allow-scripts")                │
│                                                         │
│  App code calls fetch("/api/users")                     │
│         │                                               │
│         ▼                                               │
│  ┌──────────────────┐                                  │
│  │ HermeticNet Shim  │  Overrides: window.fetch,       │
│  │                   │  XMLHttpRequest, WebSocket       │
│  └────────┬──────────┘                                  │
│           │ MessageChannel.port.postMessage({            │
│           │   type: "request", id, method, url, ...     │
│           │ })                                          │
└───────────┼─────────────────────────────────────────────┘
            │  MessageChannel (transferred port)
┌───────────┼─────────────────────────────────────────────┐
│ Host      │                                              │
│           ▼                                              │
│  ┌──────────────────┐                                   │
│  │ HermeticNet       │  Reconstructs Request object,    │
│  │ Router            │  routes to server handler        │
│  └────────┬──────────┘                                  │
│           ▼                                              │
│  ┌──────────────────┐                                   │
│  │ Server Runtime    │  Hono, Express adapter, or any   │
│  │ (HermeticVM)     │  (Request) => Response handler    │
│  └────────┬──────────┘                                  │
│           │  Response serialized back via MessageChannel  │
└───────────┼──────────────────────────────────────────────┘
            ▼
   Preview shim resolves Promise with Response
```

### 8.3 What This Is NOT (Patent Distinction)

This is NOT:
- ❌ A cross-origin relay mechanism
- ❌ An invisible window with an embedded iframe
- ❌ A Service Worker installed on a separate domain
- ❌ Two local domains communicating via intermediary
- ❌ A simulation of TCP networking
- ❌ Anything described in US Patent Application 2022/0147376 or 2024/0146640

This IS:
- ✅ A JavaScript function shim (overriding `window.fetch`)
- ✅ Standard `MessageChannel` API (WHATWG HTML spec, since 2010)
- ✅ Direct function invocation (calling Hono's `.fetch()` handler)
- ✅ A same-origin (opaque origin via sandbox) iframe
- ✅ Structured clone algorithm for data transfer

### 8.4 Fetch Shim (Injected into Preview)

```typescript
const pending = new Map<string, { resolve: Function; reject: Function }>();
let port: MessagePort | null = null;
let reqCounter = 0;

// Receive MessageChannel port from parent
window.addEventListener("message", (event) => {
  if (event.data?.type === "hermetic-net-init" && event.ports[0]) {
    port = event.ports[0];
    port.onmessage = handleResponse;
  }
});

function handleResponse(event: MessageEvent) {
  const { id, status, statusText, headers, body, error, streaming } = event.data;
  const handler = pending.get(id);
  if (!handler) return;

  if (error) {
    handler.reject(new TypeError(error));
    pending.delete(id);
    return;
  }

  if (streaming) {
    // Create ReadableStream for chunked responses
    const stream = new ReadableStream({
      start(controller) {
        streamHandlers.set(id, {
          chunk: (data: ArrayBuffer) => controller.enqueue(new Uint8Array(data)),
          end: () => { controller.close(); pending.delete(id); },
          error: (e: string) => { controller.error(new Error(e)); pending.delete(id); },
        });
      }
    });
    handler.resolve(new Response(stream, { status, statusText, headers }));
  } else {
    handler.resolve(new Response(body, { status, statusText, headers }));
    pending.delete(id);
  }
}

// Override fetch — intercept relative/localhost, pass through external
const originalFetch = window.fetch;
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url, window.location.href);

  // Only intercept relative URLs and localhost
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" &&
      url.origin !== window.location.origin && !url.hostname.endsWith(".local")) {
    return originalFetch(input, init);
  }

  if (!port) return Promise.reject(new Error("HermeticNet not initialized"));

  return new Promise((resolve, reject) => {
    const id = `req_${reqCounter++}`;
    pending.set(id, { resolve, reject });
    request.arrayBuffer().then(bodyBuffer => {
      port!.postMessage({
        type: "request", id,
        method: request.method,
        url: url.pathname + url.search,
        headers: Object.fromEntries(request.headers.entries()),
        body: bodyBuffer.byteLength > 0 ? bodyBuffer : null,
      });
    });
  });
};
```

### 8.5 Router (Host Side)

```typescript
type ServerHandler = (request: Request) => Response | Promise<Response>;

function createRouter(handler: ServerHandler) {
  return function routeMessage(event: MessageEvent, port: MessagePort) {
    const { id, method, url, headers, body } = event.data;
    if (event.data.type !== "request") return;

    const request = new Request(`http://localhost${url}`, {
      method,
      headers: new Headers(headers),
      body: body ? new Uint8Array(body) : undefined,
    });

    Promise.resolve(handler(request))
      .then(async (response) => {
        if (response.body && !response.headers.get("content-length")) {
          // Streaming response
          port.postMessage({ id, status: response.status, statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()), streaming: true });
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) { port.postMessage({ id, type: "stream-end" }); break; }
            port.postMessage({ id, type: "stream-chunk", chunk: value.buffer }, [value.buffer]);
          }
        } else {
          const responseBody = await response.arrayBuffer();
          port.postMessage({ id, status: response.status, statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()), body: responseBody });
        }
      })
      .catch((error) => {
        port.postMessage({ id, error: error.message || "Internal Server Error" });
      });
  };
}
```

### 8.6 Connection Setup

```typescript
function setupHermeticNet(iframe: HTMLIFrameElement, handler: ServerHandler) {
  const channel = new MessageChannel();
  const router = createRouter(handler);
  channel.port2.onmessage = (event) => router(event, channel.port2);
  iframe.addEventListener("load", () => {
    iframe.contentWindow!.postMessage({ type: "hermetic-net-init" }, "*", [channel.port1]);
  });
}
```

### 8.7 Additional Shims

The preview iframe also needs shims for:
- **WebSocket** — `ForgeWebSocket` class that routes through MessageChannel
- **XMLHttpRequest** — Proxy XHR through same MessageChannel mechanism
- **`window.location`** — Virtual URL reflecting current route
- **`history.pushState/replaceState`** — Forward navigation events to host
- **`document.cookie`** — Virtual cookie jar in memory

---

## 9. Subsystem 7: HermeticDev — Dev Server & Preview

### 9.1 Purpose

Live development preview with hot module replacement. Source files change → esbuild-wasm rebuilds → preview updates without full reload.

### 9.2 Build Pipeline

```
Source files change in HermeticFS
  → HermeticFS.watch() fires (FileSystemObserver or polling)
  → esbuild-wasm rebuilds affected modules
  → HermeticDev sends HMR update via MessageChannel
  → Preview iframe applies update (module hot-swap or full reload)
```

### 9.3 API Surface

```typescript
interface HermeticDev {
  start(options: DevOptions): Promise<DevServer>;
}

interface DevOptions {
  root: string;            // Project root in HermeticFS
  entry: string;           // Entry point (e.g., "src/main.tsx")
  framework?: "react" | "vue" | "svelte" | "vanilla";
  port?: number;           // Virtual port (display only)
}

interface DevServer {
  iframe: HTMLIFrameElement;
  reload(): void;
  dispose(): void;
  on(event: "build", callback: (result: BuildResult) => void): void;
  on(event: "error", callback: (error: BuildError) => void): void;
  on(event: "hmr", callback: (modules: string[]) => void): void;
}
```

### 9.4 HMR Protocol

```typescript
// Update specific modules:
{ type: "hermetic-hmr-update", modules: [{ path: string, code: string, acceptSelf: boolean }] }

// CSS hot update (no JS reload needed):
{ type: "hermetic-hmr-css", path: string, css: string }

// Full reload when HMR boundary can't be preserved:
{ type: "hermetic-hmr-reload", reason: string }
```

### 9.5 React Fast Refresh

Wrap compiled modules with React Fast Refresh runtime (MIT, public API):
```typescript
// Before user module: inject $RefreshReg$ / $RefreshSig$
// After user module: call RefreshRuntime.performReactRefresh()
```

---

## 10. Patent Avoidance Analysis

### 10.1 The Patent

StackBlitz/WebContainers patent (US Application 2022/0147376) covers a cross-origin Service Worker relay mechanism — HTTP requests from sandboxed code intercepted by a Service Worker on a different origin, which relays them to create virtual network isolation.

### 10.2 Three Independent Bypass Mechanisms

**1. MessageChannel networking** — HermeticNet uses `MessageChannel` + `postMessage` to route requests between sandboxed Worker and host. No Service Worker relay. No cross-origin dance. Completely different mechanism.

**2. OPFS eliminates their core FS architecture** — WebContainers built a custom filesystem inside SharedArrayBuffer because OPFS sync handles didn't exist yet. Hermetic's filesystem is just OPFS — a standard browser API. Nothing to patent about using a standard API.

**3. Sandboxed iframe with opaque origin replaces their origin isolation** — They create virtual origins via cross-origin relay. Hermetic creates actual origin isolation via `sandbox` attribute (opaque origin = null origin). Standard browser security primitive, in the spec for over a decade.

### 10.3 Claim-by-Claim Distinction

| Patent Claim Element | Hermetic Equivalent | Infringement Risk |
|---------------------|---------------------|-------------------|
| "Local computing server on a first local domain" | Runtime Worker on same origin | Different — no separate domain |
| "Local web server on a second local domain" | Preview iframe on opaque origin | Different — no second domain |
| "Relay mechanism with iFrame and invisible window" | No relay. Direct MessageChannel. | **Absent** — element doesn't exist |
| "Service worker on the invisible window" | No service worker. No invisible window. | **Absent** — element doesn't exist |
| "Communicatively connect second domain to iFrame" | MessageChannel port transfer | Different — no domain connection |

### 10.4 Why Modern Primitives Make the Patent Unnecessary

WebContainers was designed ~2021 when OPFS sync handles, JSPI, FileSystemObserver, and Transferable Streams didn't exist. The patented technique was necessary then. These modern primitives make it unnecessary now. Hermetic isn't bypassing the patent — it's using the platform the patent authors wished they'd had.

### 10.5 Recommended Legal Review Before Shipping

1. Obtain full granted patent claims (not just application abstract)
2. Have patent attorney perform formal freedom-to-operate analysis
3. This spec serves as clean-room design evidence
4. Consider defensive publication of the MessageChannel approach

---

## 11. Integration Patterns

### 11.1 Full Runtime Setup

```typescript
import { Hermetic } from "@hermetic/runtime";

const runtime = await Hermetic.create();

// Write a file
await runtime.fs.writeFile("/app.ts", `
  import { Hono } from "npm:hono";
  const app = new Hono();
  app.get("/", (c) => c.text("Hello from Hermetic!"));
  export default app;
`);

// Start preview
const preview = await runtime.dev.start({ root: "/", entry: "app.ts" });
document.body.appendChild(preview.iframe);
```

### 11.2 Composable Setup (Just FS + Preview)

```typescript
import { createFS } from "@hermetic/fs";
import { createNet } from "@hermetic/net";

const fs = await createFS({ backend: "memory" });
await fs.writeFile("/index.html", "<h1>Hello World</h1>");

const net = createNet();
const iframe = net.createPreview({
  handler: async (request) => {
    const path = new URL(request.url).pathname;
    const file = path === "/" ? "/index.html" : path;
    try {
      const content = await fs.readFile(file);
      return new Response(content, { headers: { "content-type": guessMimeType(file) } });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
});
document.body.appendChild(iframe);
```

### 11.3 Shell Session

```typescript
const runtime = await Hermetic.create();

// Attach to xterm.js terminal
const terminal = new Terminal();
runtime.shell.pipe(terminal);

// Or execute programmatically
const result = await runtime.shell.exec("ls -la /");
console.log(result.stdout);

await runtime.shell.exec("npm install hono");
await runtime.shell.exec("echo 'console.log(42)' > test.js");
await runtime.shell.exec("node test.js"); // stdout: "42"
```

### 11.4 IDE Integration (Wiggum/Bureau)

```
IDE Application
├── HermeticFS → project files, npm packages (OPFS, persistent)
├── HermeticVM → V8 for frontend code, QuickJS-wasm for sandboxed plugins
├── HermeticNet → preview ↔ Hono routing (MessageChannel)
├── HermeticDev → live preview with HMR via esbuild-wasm
├── HermeticPM → esm.sh fast path + full npm resolution
└── HermeticShell → terminal with built-in commands
```

---

## 12. Prior Art & Public Sources

Every design decision traces to public sources:

### 12.1 Web Standards

| Standard | Body | Used By |
|----------|------|---------|
| OPFS (File System Standard) | WHATWG | HermeticFS |
| Web Workers | WHATWG HTML | HermeticProc |
| MessageChannel / postMessage | WHATWG HTML | HermeticNet |
| Structured Clone Algorithm | WHATWG HTML | HermeticNet data transfer |
| Streams API | WHATWG | Transferable Streams everywhere |
| Fetch API | WHATWG | HermeticNet shim target |
| IndexedDB | W3C | HermeticFS fallback, HermeticPM cache |
| iframe sandbox | WHATWG HTML | Isolation perimeter |
| FileSystemObserver | WHATWG (draft) | HermeticFS watching |
| JSPI | W3C Wasm | HermeticVM txiki.js tier |
| ShadowRealm | TC39 Stage 2.7 | Future Tier 0 isolation |

### 12.2 Open-Source Reference Implementations

| Project | License | Validates |
|---------|---------|-----------|
| txiki.js | MIT | HermeticVM full runtime |
| QuickJS-ng | MIT | HermeticVM isolated engine |
| memfs | MIT | HermeticFS API design |
| ZenFS / BrowserFS | MIT | HermeticFS OPFS backend |
| LightningFS | MIT | HermeticFS IndexedDB backend |
| isomorphic-git | MIT | Git integration |
| esbuild-wasm | MIT | HermeticDev build pipeline |
| Hono | MIT | HermeticNet server handler |
| xterm.js | MIT | HermeticShell terminal |
| remote-web-streams | MIT | Transferable Streams patterns |

---

## 13. Implementation Roadmap

### Phase 1: Foundation (MVP)

**HermeticFS** — OPFS backend with full POSIX API
**HermeticNet** — MessageChannel fetch shim + router

Milestone: "Write an HTML file, preview it in an iframe with working fetch."

### Phase 2: Execution

**HermeticVM** — Browser-native V8 execution in sandbox Workers
**HermeticDev** — esbuild-wasm build pipeline + HMR

Milestone: "Write a React app, see it live in preview with hot reloading."

### Phase 3: Package Ecosystem

**HermeticPM** — npm registry client + CDN resolution + tarball extraction

Milestone: "npm install works in the browser."

### Phase 4: Interactive Environment

**HermeticProc** — Web Worker process model with Transferable Streams
**HermeticShell** — Shell interpreter with built-in commands

Milestone: "Open a terminal, type commands, see output."

### Phase 5: Isolation Tier

**HermeticVM (QuickJS-ng Wasm)** — Sandboxed execution with memory/time limits

Milestone: "Run untrusted code with resource caps."

### Phase 6: Full Runtime (Future)

**HermeticVM (txiki.js Wasm + JSPI)** — Complete runtime with event loop in Wasm

Milestone: "Server-side code with real event loop runs natively in browser."

---

## 14. Advantages Over WebContainers

| Dimension | WebContainers | Hermetic |
|-----------|--------------|----------|
| License | Proprietary | MIT |
| Filesystem | SharedArrayBuffer memory FS | OPFS sync handles (faster, persistent) |
| COI Headers | Required | Not required |
| Safari/iOS | ❌ (needs SharedArrayBuffer) | ✅ (OPFS works everywhere) |
| Persistence | Ephemeral (memory only) | Persistent (OPFS survives reload) |
| File watching | Polling / custom events | FileSystemObserver (native) |
| Wasm bridge | Asyncify (2x code bloat) | JSPI (constant-time, no bloat) |
| Network isolation | Cross-origin relay (patented) | MessageChannel (standard API) |
| Security model | Origin isolation via relay | Capability bindings (Cloudflare model) |
| IPC | SharedArrayBuffer | Transferable Streams (zero-copy) |
| Concurrency | Limited by SAB | `readwrite-unsafe` concurrent OPFS |

---

## 15. Claude Code Implementation Instructions

### 15.1 Project Setup

```
hermetic/
├── packages/
│   ├── core/          # @hermetic/core — shared types, MessageChannel protocol
│   ├── fs/            # @hermetic/fs — OPFS + IDB + memory backends
│   ├── vm/            # @hermetic/vm — execution contexts
│   ├── proc/          # @hermetic/proc — Worker process model
│   ├── pm/            # @hermetic/pm — npm registry client
│   ├── shell/         # @hermetic/shell — shell interpreter
│   ├── net/           # @hermetic/net — fetch shim + router
│   ├── dev/           # @hermetic/dev — esbuild-wasm + HMR
│   └── runtime/       # @hermetic/runtime — full runtime facade
├── apps/
│   └── playground/    # Demo app showing Hermetic in action
├── tests/
│   ├── unit/
│   └── integration/
├── package.json       # Workspace root
├── tsconfig.json
└── README.md
```

### 15.2 Build Tooling

- **Package manager:** pnpm with workspaces
- **Build:** tsup for library builds (ESM + CJS)
- **TypeScript:** strict mode, ES2022 target
- **Testing:** vitest (runs in browser mode for Web API tests)
- **Linting:** eslint + prettier

### 15.3 Implementation Order (Critical Path)

```
1. @hermetic/core        — Types, MessageChannel protocol, capability binding base
2. @hermetic/fs           — OPFS backend first, then IDB fallback, then memory
3. @hermetic/net          — Fetch shim + router + preview iframe creation
4. @hermetic/vm           — Native V8 Worker context with capability injection
5. @hermetic/dev          — esbuild-wasm pipeline + HMR
6. @hermetic/pm           — CDN-first resolution + full install path
7. @hermetic/proc         — Worker process model + Transferable Streams pipes
8. @hermetic/shell        — Parser + built-in commands + external command dispatch
9. @hermetic/runtime      — Facade that wires everything together
10. apps/playground       — Interactive demo
```

### 15.4 Critical Implementation Details

**MessageChannel Protocol (@hermetic/core):**
All cross-context communication uses a typed message protocol. Every message has a `type` discriminant and correlation `id`. Define this protocol as TypeScript discriminated unions. This is the backbone — get it right first.

```typescript
type HermeticMessage =
  | { type: "fs.readFile"; id: string; path: string }
  | { type: "fs.readFile.result"; id: string; data: ArrayBuffer }
  | { type: "fs.readFile.error"; id: string; error: string }
  | { type: "net.request"; id: string; method: string; url: string; headers: Record<string, string>; body: ArrayBuffer | null }
  | { type: "net.response"; id: string; status: number; statusText: string; headers: Record<string, string>; body: ArrayBuffer }
  | { type: "net.stream.chunk"; id: string; chunk: ArrayBuffer }
  | { type: "net.stream.end"; id: string }
  | { type: "proc.spawn"; id: string; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { type: "proc.stdout"; pid: number; data: ArrayBuffer }
  | { type: "proc.exit"; pid: number; code: number }
  // ... etc
```

**Sandbox Iframe Creation (@hermetic/net):**
```typescript
function createSandboxIframe(shimCode: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.sandbox.add("allow-scripts"); // NO allow-same-origin
  iframe.srcdoc = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta http-equiv="Content-Security-Policy"
            content="script-src 'unsafe-inline' blob:; connect-src 'none';">
    </head>
    <body>
      <script>${shimCode}</script>
    </body>
    </html>
  `;
  iframe.style.border = "none";
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  return iframe;
}
```

**OPFS Worker (@hermetic/fs):**
The FS Worker must be a dedicated Worker that opens OPFS handles on init and keeps them available for sync operations. Main thread sends requests via MessageChannel, FS Worker executes against OPFS sync handles, sends results back. Never expose OPFS handles to user code.

**Capability Binding Injection (@hermetic/vm):**
When creating a Worker for user code, prepend the capability binding code before user code in the Blob URL:
```typescript
function createUserWorker(userCode: string, bindings: string): Worker {
  const fullCode = `${bindings}\n\n// --- User code below ---\n\n${userCode}`;
  const blob = new Blob([fullCode], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
}
```

### 15.5 Testing Strategy

- **Unit tests:** Each package has isolated unit tests (vitest)
- **Browser tests:** vitest browser mode for Web API tests (OPFS, Workers, MessageChannel)
- **Integration tests:** Full runtime tests that write files, install packages, run commands, verify preview output
- **Isolation tests:** Verify sandbox cannot access parent DOM, cookies, storage
- **Patent compliance tests:** Verify no Service Worker relay, no cross-origin communication

### 15.6 What NOT To Do

- Do NOT use SharedArrayBuffer as a primary dependency — OPFS sync handles replace this need
- Do NOT create Service Workers for networking — MessageChannel replaces this
- Do NOT create cross-origin iframes — sandboxed same-origin (opaque) replaces this
- Do NOT bundle the entire runtime — each package must be independently importable
- Do NOT implement Node.js `fs` API verbatim — implement Hermetic's own API, provide optional Node.js shim separately
- Do NOT use `eval()` on the host page — all code execution happens inside sandbox iframe Workers
- Do NOT reference WebContainers source code, documentation, or implementation details — clean-room only
- Do NOT implement Tiers 0, 2, 3 in Phase 1 — Tier 1 only, document others as future enhancements

---

## License

```
MIT License

Copyright (c) 2025 Hermetic Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
