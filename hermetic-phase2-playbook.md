# Hermetic Phase 2: Hardening, Security & Performance

**Context:** Phase 1 is complete. The architecture is correct — protocol, channel, OPFS worker, sandbox iframe, capability bindings all follow the spec. This document fixes the gaps, hardens security, optimizes performance, and completes stub implementations.

**Read the original spec first:** `hermetic-spec.md` remains the authoritative design document.

**Rules:**
- Follow steps IN ORDER. Each has a VERIFY gate.
- Do NOT skip ahead. Later steps depend on earlier fixes.
- When editing existing files, preserve all working functionality.
- Run `pnpm build` and `pnpm test` after EVERY step.
- Test in browser mode for any OPFS, Worker, or iframe changes.

---

## Step 0: Audit & Baseline

Before touching anything, establish what works.

```bash
cd hermetic
pnpm install
pnpm build
pnpm test
```

Document which tests pass and which fail. If any builds fail, fix those FIRST before proceeding. Every subsequent step assumes a green baseline.

**VERIFY:**
- [ ] `pnpm build` succeeds for all packages
- [ ] `pnpm test` passes for all packages
- [ ] Note any warnings or failures as baseline

---

## Step 1: Fix OPFS Backend RPC Architecture

**Problem:** `packages/fs/src/backends/opfs.ts` creates a `HermeticChannel` (line 40) but never uses it. Instead it duplicates the entire RPC pattern in a private `rpc()` method (lines 48-82). This means OPFS communication bypasses the core protocol, error serialization is inconsistent, and there's no timeout cleanup on dispose.

**Fix:** Rewire OPFSFS to communicate with its Worker through `HermeticChannel` properly. The OPFS Worker (`opfs-worker.ts`) currently uses `self.onmessage` — change it to receive a `MessagePort` on init and communicate through that.

### 1.1 Update `packages/fs/src/opfs-worker.ts`

Change the worker to accept a MessagePort on initialization:

```typescript
// At the top, replace self.onmessage with port-based communication
let port: MessagePort;
let opfsRoot: FileSystemDirectoryHandle;

self.onmessage = (event: MessageEvent) => {
  // First message transfers the communication port
  if (event.data?.__hermetic && event.data.ns === "init" && event.ports.length > 0) {
    port = event.ports[0];
    port.onmessage = handleRequest;
    port.start();
    return;
  }
};

async function handleRequest(event: MessageEvent) {
  const msg = event.data;
  if (!msg?.__hermetic || msg.ns !== "fs") return;
  if (!opfsRoot) opfsRoot = await navigator.storage.getDirectory();

  try {
    let result: unknown;
    const transfer: Transferable[] = [];

    switch (msg.method) {
      // ... all existing cases stay the same ...
    }

    port.postMessage(
      { __hermetic: true, ns: "fs", id: msg.id, ok: true, value: result },
      transfer,
    );
  } catch (err: unknown) {
    port.postMessage({
      __hermetic: true, ns: "fs", id: msg.id,
      ok: false, error: mapFSError(err, msg.method, msg.args?.[0]),
    });
  }
}
```

### 1.2 Rewrite `packages/fs/src/backends/opfs.ts`

Delete the private `rpc()` method entirely. Use `HermeticChannel` for all communication:

```typescript
static async create(): Promise<OPFSFS> {
  const blob = new Blob([OPFS_WORKER_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);

  // Create MessageChannel — port1 stays on main thread, port2 goes to Worker
  const { port1, port2 } = new MessageChannel();
  worker.postMessage(
    { __hermetic: true, ns: "init" },
    [port2] // Transfer port2 to worker
  );

  const channel = new HermeticChannel(port1);
  return new OPFSFS(worker, channel);
}

// Then all methods use channel.call():
async readFile(path: string, encoding?: "utf-8"): Promise<Uint8Array | string> {
  const buffer = (await this.channel.call("fs", "readFile", [path])) as ArrayBuffer;
  if (encoding === "utf-8") return new TextDecoder().decode(buffer);
  return new Uint8Array(buffer);
}

// Delete the entire private rpc() method (lines 48-82)
```

### 1.3 Add `read-only` mode for reads

In `opfs-worker.ts`, update `readFile` and `stat` to use `{ mode: "read-only" }`:

```typescript
async function readFile(path: string): Promise<ArrayBuffer> {
  const fileHandle = await navigateToFile(path);
  // Use read-only mode — allows concurrent reads, no exclusive lock
  const accessHandle = await fileHandle.createSyncAccessHandle({ mode: "read-only" });
  try {
    const size = accessHandle.getSize();
    const buffer = new ArrayBuffer(size);
    accessHandle.read(new DataView(buffer), { at: 0 });
    return buffer;
  } finally {
    accessHandle.close();
  }
}
```

Similarly update `stat()` to use `{ mode: "read-only" }` when getting file size.

Note: `{ mode: "read-only" }` requires Chrome 121+. Add a feature-detect fallback:

```typescript
let supportsReadOnlyMode = true; // optimistic

async function openReadOnly(fileHandle: FileSystemFileHandle) {
  if (supportsReadOnlyMode) {
    try {
      return await fileHandle.createSyncAccessHandle({ mode: "read-only" });
    } catch (e) {
      if (e instanceof TypeError) {
        supportsReadOnlyMode = false;
        // Fall through to default
      } else throw e;
    }
  }
  return await fileHandle.createSyncAccessHandle();
}
```

**VERIFY:**
- [ ] OPFS backend works exactly as before (no regressions)
- [ ] `HermeticChannel` is the only RPC mechanism (no more raw `worker.postMessage`)
- [ ] Concurrent reads don't throw EBUSY (test with parallel `readFile` calls)
- [ ] Worker properly receives port and communicates through it
- [ ] `pnpm build && pnpm test` passes

---

## Step 2: Implement IndexedDB Fallback Backend

**Problem:** The spec requires three backends (OPFS, IndexedDB, memory). Only OPFS and memory exist. Firefox < 111 and some Safari configurations need IndexedDB.

Create `packages/fs/src/backends/indexeddb.ts`:

```typescript
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

  static async create(): Promise<IndexedDBFS> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
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

  // ... implement all HermeticFS methods using IDB transactions ...
}
```

**Implementation notes:**
- Each FS operation is a single IDB transaction
- `readFile`: get node by path, return content
- `writeFile`: put node with content as ArrayBuffer
- `mkdir`: put node with type "directory"
- `readdir`: open cursor, filter by parent path prefix
- `stat`: get node, return metadata
- `unlink`/`rmdir`: delete node(s) by path
- `rename`: get old node, put at new path, delete old
- Directories are stored as nodes with `type: "directory"` and no content

For `readdir`, use an IDB cursor with a key range to find children:
```typescript
async readdir(path: string): Promise<string[]> {
  const normalized = normalizePath(path);
  const prefix = normalized === "/" ? "/" : normalized + "/";

  return new Promise((resolve, reject) => {
    const tx = this.db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const entries: string[] = [];

    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(entries); return; }

      const nodePath: string = cursor.value.path;
      if (nodePath !== normalized && nodePath.startsWith(prefix)) {
        // Only direct children (no further slashes after prefix)
        const rest = nodePath.slice(prefix.length);
        if (!rest.includes("/")) {
          entries.push(rest);
        }
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
```

Update `packages/fs/src/index.ts` to include IndexedDB in the backend selection:

```typescript
export async function createFS(options?: FSOptions): Promise<HermeticFS> {
  const backend = options?.backend ?? detectBestBackend();
  switch (backend) {
    case "opfs": return OPFSFS.create();
    case "indexeddb": return IndexedDBFS.create();
    case "memory": return new MemoryFS();
  }
}

function detectBestBackend(): "opfs" | "indexeddb" | "memory" {
  if (typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage) {
    return "opfs";
  }
  if (typeof indexedDB !== "undefined") {
    return "indexeddb";
  }
  return "memory";
}
```

Write tests: `packages/fs/tests/indexeddb.browser.test.ts` — run the SAME test suite as memory backend but against IndexedDB. Use a unique DB name per test to avoid collisions.

**VERIFY:**
- [ ] IndexedDB backend passes the same test suite as memory backend
- [ ] Auto-detection selects OPFS > IndexedDB > memory
- [ ] `createFS({ backend: "indexeddb" })` works explicitly
- [ ] `pnpm build && pnpm test` passes

---

## Step 3: Implement Real Shell Piping

**Problem:** `packages/shell/src/executor.ts` line 56-81 — `executePipeline()` concatenates stdout strings instead of actually piping output from one command to the next. `ls | grep foo` doesn't work.

**Fix:** Pass the previous command's stdout as stdin to the next command. Since shell builtins are synchronous text operations (not streaming), text-based piping is appropriate here. Stream-based piping is for `@hermetic/proc` Worker processes.

Replace `executePipeline`:

```typescript
async function executePipeline(node: PipelineNode, ctx: ExecContext): Promise<ShellOutput> {
  let stdin = "";
  let lastResult: ShellOutput = { stdout: "", stderr: "", exitCode: 0 };

  for (let i = 0; i < node.commands.length; i++) {
    const cmd = node.commands[i];

    // Create a context extension that includes stdin from previous command
    const pipeCtx: ExecContext & { stdin?: string } = { ...ctx, stdin };

    const result = await executeWithStdin(cmd, pipeCtx);

    // This command's stdout becomes next command's stdin
    stdin = result.stdout;

    // Accumulate stderr from all commands
    lastResult = {
      stdout: result.stdout,
      stderr: lastResult.stderr + result.stderr,
      exitCode: result.exitCode,
    };
  }

  return lastResult;
}
```

Update builtins that should accept stdin to check for piped input. Update the `ExecContext` type to include `stdin?: string`:

```typescript
export interface ExecContext {
  fs: HermeticFS;
  cwd: string;
  env: Record<string, string>;
  setCwd: (path: string) => void;
  stdin?: string; // Piped input from previous command
}
```

Update builtins that should read from stdin when no file argument is provided:

**`grep`** — if no filename given, search stdin:
```typescript
grep: async (args: string[], ctx: ExecContext) => {
  const pattern = args[0];
  if (!pattern) return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 2 };

  let input: string;
  if (args.length > 1) {
    // Read from file
    const path = resolvePath(ctx.cwd, args[1]);
    input = await ctx.fs.readFile(path, "utf-8") as string;
  } else if (ctx.stdin) {
    // Read from pipe
    input = ctx.stdin;
  } else {
    return { stdout: "", stderr: "grep: no input\n", exitCode: 2 };
  }

  const regex = new RegExp(pattern);
  const matches = input.split("\n").filter(line => regex.test(line));
  return { stdout: matches.join("\n") + (matches.length ? "\n" : ""), stderr: "", exitCode: matches.length ? 0 : 1 };
}
```

Apply similar stdin support to: `cat`, `sort`, `head`, `tail`, `wc`, `uniq`, `tr`.

Add `sort`, `head`, `tail`, `wc`, `uniq` to builtins if not already present:

```typescript
sort: async (args: string[], ctx: ExecContext) => {
  const input = args[0]
    ? await ctx.fs.readFile(resolvePath(ctx.cwd, args[0]), "utf-8") as string
    : ctx.stdin ?? "";
  const lines = input.split("\n").filter(Boolean);
  const reverse = args.includes("-r");
  lines.sort();
  if (reverse) lines.reverse();
  return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
},

head: async (args: string[], ctx: ExecContext) => {
  let n = 10;
  const filtered: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-n")) {
      n = parseInt(arg.slice(2)) || parseInt(args[args.indexOf(arg) + 1]) || 10;
    } else if (!/^\d+$/.test(arg)) filtered.push(arg);
  }
  const input = filtered[0]
    ? await ctx.fs.readFile(resolvePath(ctx.cwd, filtered[0]), "utf-8") as string
    : ctx.stdin ?? "";
  const lines = input.split("\n").slice(0, n);
  return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
},

tail: async (args: string[], ctx: ExecContext) => {
  let n = 10;
  const filtered: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-n")) {
      n = parseInt(arg.slice(2)) || parseInt(args[args.indexOf(arg) + 1]) || 10;
    } else if (!/^\d+$/.test(arg)) filtered.push(arg);
  }
  const input = filtered[0]
    ? await ctx.fs.readFile(resolvePath(ctx.cwd, filtered[0]), "utf-8") as string
    : ctx.stdin ?? "";
  const lines = input.split("\n");
  const result = lines.slice(-n);
  return { stdout: result.join("\n") + "\n", stderr: "", exitCode: 0 };
},

wc: async (args: string[], ctx: ExecContext) => {
  const input = args[0]
    ? await ctx.fs.readFile(resolvePath(ctx.cwd, args[0]), "utf-8") as string
    : ctx.stdin ?? "";
  const lines = input.split("\n").length - (input.endsWith("\n") ? 1 : 0);
  const words = input.split(/\s+/).filter(Boolean).length;
  const chars = input.length;
  return { stdout: `  ${lines}  ${words}  ${chars}\n`, stderr: "", exitCode: 0 };
},
```

Write pipe tests: `packages/shell/tests/pipe.test.ts`

```typescript
it("pipes ls output through grep", async () => {
  await fs.writeFile("/foo.txt", "hello");
  await fs.writeFile("/bar.js", "world");
  const result = await shell.exec("ls / | grep .js");
  expect(result.stdout.trim()).toBe("bar.js");
});

it("three-stage pipe: ls | sort | head", async () => { ... });
it("pipe preserves exit code of last command", async () => { ... });
```

**VERIFY:**
- [ ] `ls | grep foo` works
- [ ] `cat file.txt | sort | head -5` works
- [ ] `echo hello | wc` works
- [ ] Three-stage pipes work
- [ ] Exit code from last command in pipe is used
- [ ] All existing shell tests still pass
- [ ] `pnpm build && pnpm test` passes

---

## Step 4: Implement Real Glob Expansion

**Problem:** `ls *.js` passes the literal string `*.js` to the ls builtin. No glob expansion happens.

Create `packages/shell/src/glob.ts`:

```typescript
import type { HermeticFS } from "@hermetic/fs";
import { dirname, basename, joinPath, normalizePath } from "@hermetic/core";

/**
 * Expand glob patterns against HermeticFS.
 * Supports: * (any chars), ? (single char), ** (recursive)
 */
export async function expandGlob(
  pattern: string,
  cwd: string,
  fs: HermeticFS,
): Promise<string[]> {
  // If no glob characters, return as-is
  if (!/[*?]/.test(pattern)) return [pattern];

  const resolved = pattern.startsWith("/") ? pattern : joinPath(cwd, pattern);
  const parts = normalizePath(resolved).split("/").filter(Boolean);

  return matchParts(parts, "/", fs);
}

async function matchParts(
  parts: string[],
  base: string,
  fs: HermeticFS,
): Promise<string[]> {
  if (parts.length === 0) return [base];

  const [current, ...rest] = parts;

  if (current === "**") {
    // Recursive: match current dir + all subdirs
    const results: string[] = [];
    results.push(...(await matchParts(rest, base, fs)));
    try {
      const entries = await fs.readdir(base);
      for (const entry of entries) {
        const full = joinPath(base, entry);
        const stat = await fs.stat(full);
        if (stat.type === "directory") {
          results.push(...(await matchParts(parts, full, fs))); // keep ** for recursion
          results.push(...(await matchParts(rest, full, fs)));   // skip ** for this level
        }
      }
    } catch {}
    return [...new Set(results)];
  }

  const regex = globPartToRegex(current);
  try {
    const entries = await fs.readdir(base);
    const matches = entries.filter((e) => regex.test(e));

    if (rest.length === 0) {
      return matches.map((m) => joinPath(base, m));
    }

    const results: string[] = [];
    for (const match of matches) {
      const full = joinPath(base, match);
      try {
        const stat = await fs.stat(full);
        if (stat.type === "directory") {
          results.push(...(await matchParts(rest, full, fs)));
        }
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}

function globPartToRegex(pattern: string): RegExp {
  let regex = "^";
  for (const char of pattern) {
    switch (char) {
      case "*": regex += "[^/]*"; break;
      case "?": regex += "[^/]"; break;
      case ".": regex += "\\."; break;
      default: regex += char;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
```

Wire glob expansion into the executor. In `packages/shell/src/executor.ts`, expand globs in command args BEFORE passing to builtins:

```typescript
async function executeCommand(node: CommandNode, ctx: ExecContext): Promise<ShellOutput> {
  // ... existing assignment handling ...

  // Expand variables
  const name = expandVariables(node.name, ctx.env);
  let args = node.args.map((a) => expandVariables(a, ctx.env));

  // Expand globs
  const expandedArgs: string[] = [];
  for (const arg of args) {
    if (/[*?]/.test(arg)) {
      const matches = await expandGlob(arg, ctx.cwd, ctx.fs);
      if (matches.length > 0) {
        expandedArgs.push(...matches);
      } else {
        expandedArgs.push(arg); // No match — pass literal (bash behavior)
      }
    } else {
      expandedArgs.push(arg);
    }
  }
  args = expandedArgs;

  // ... rest of execution ...
}
```

Write tests: `packages/shell/tests/glob.test.ts`

```typescript
it("ls *.txt matches text files", async () => {
  await fs.writeFile("/foo.txt", "");
  await fs.writeFile("/bar.txt", "");
  await fs.writeFile("/baz.js", "");
  const result = await shell.exec("ls *.txt");
  expect(result.stdout).toContain("foo.txt");
  expect(result.stdout).toContain("bar.txt");
  expect(result.stdout).not.toContain("baz.js");
});

it("rm *.tmp removes matching files", async () => { ... });
it("no match returns literal (bash behavior)", async () => { ... });
it("? matches single character", async () => { ... });
```

**VERIFY:**
- [ ] `ls *.js` expands and lists only .js files
- [ ] `rm *.tmp` removes matching files
- [ ] `cat src/*.ts` works with directory prefix
- [ ] No-match returns literal string
- [ ] `?` matches single character
- [ ] All existing tests still pass
- [ ] `pnpm build && pnpm test` passes

---

## Step 5: Wire Proc to Actually Execute Code

**Problem:** `packages/proc/src/proc.ts` lines 133-151 — `generateWorkerCode()` creates a Worker that immediately exits without executing anything. The process model is a complete stub.

**Fix:** The generated Worker code must actually evaluate the command. For built-in runtimes (`node`, `deno`), inject the file contents from HermeticFS and execute them. The proc module needs access to the filesystem.

### 5.1 Update HermeticProc constructor to accept FS

```typescript
export class HermeticProc implements HermeticProcInterface {
  private fs: HermeticFS;

  constructor(fs: HermeticFS) {
    this.fs = fs;
  }

  // Update spawn to use FS
  spawn(command: string, args: string[] = [], options: SpawnOptions = {}): ProcessHandle {
    // ... existing setup ...

    // For "node script.js" — read the script and execute it
    if (command === "node" && args.length > 0) {
      const scriptPath = args[0];
      this.fs.readFile(scriptPath, "utf-8").then((code) => {
        const workerCode = this.generateNodeWorkerCode(code as string);
        this.startWorker(workerCode, pid, record, stdoutWriter, stderrWriter);
      }).catch((err) => {
        stderrWriter.write(new TextEncoder().encode(`Error: ${err.message}\n`)).catch(() => {});
        record.status = "exited";
        record.exitCode = 1;
        stderrWriter.close().catch(() => {});
        stdoutWriter.close().catch(() => {});
        this.notifyWaiters(pid, 1);
      });
    } else {
      // For other commands, execute inline
      const workerCode = this.generateGenericWorkerCode(command, args);
      this.startWorker(workerCode, pid, record, stdoutWriter, stderrWriter);
    }

    // ... rest of handle setup ...
  }

  private generateNodeWorkerCode(userCode: string): string {
    return `
// Hermetic Node.js emulation layer
const __stdout = [];

const console = {
  log: (...args) => self.postMessage({ type: "stdout", data: args.join(" ") + "\\n" }),
  error: (...args) => self.postMessage({ type: "stderr", data: args.join(" ") + "\\n" }),
  warn: (...args) => self.postMessage({ type: "stderr", data: args.join(" ") + "\\n" }),
  info: (...args) => self.postMessage({ type: "stdout", data: args.join(" ") + "\\n" }),
};

const process = {
  env: {},
  argv: ["node", "script.js"],
  exit: (code) => self.postMessage({ type: "exit", code: code ?? 0 }),
  stdout: { write: (s) => self.postMessage({ type: "stdout", data: String(s) }) },
  stderr: { write: (s) => self.postMessage({ type: "stderr", data: String(s) }) },
};

try {
  ${userCode}
  self.postMessage({ type: "exit", code: 0 });
} catch(e) {
  self.postMessage({ type: "stderr", data: e.stack || e.message || String(e) });
  self.postMessage({ type: "exit", code: 1 });
}
`;
  }

  private startWorker(
    code: string,
    pid: number,
    record: ProcessRecord,
    stdoutWriter: WritableStreamDefaultWriter<Uint8Array>,
    stderrWriter: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    record.worker = worker;

    worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg?.type === "stdout") {
        const data = new TextEncoder().encode(String(msg.data));
        stdoutWriter.write(data).catch(() => {});
      } else if (msg?.type === "stderr") {
        const data = new TextEncoder().encode(String(msg.data));
        stderrWriter.write(data).catch(() => {});
      } else if (msg?.type === "exit") {
        record.status = "exited";
        record.exitCode = msg.code ?? 0;
        record.worker = null;
        stdoutWriter.close().catch(() => {});
        stderrWriter.close().catch(() => {});
        this.notifyWaiters(pid, msg.code ?? 0);
      }
    });

    worker.addEventListener("error", (e) => {
      const errMsg = e.message || "Worker error";
      stderrWriter.write(new TextEncoder().encode(errMsg + "\n")).catch(() => {});
      record.status = "exited";
      record.exitCode = 1;
      record.worker = null;
      stdoutWriter.close().catch(() => {});
      stderrWriter.close().catch(() => {});
      this.notifyWaiters(pid, 1);
    });
  }
}

export function createProc(fs: HermeticFS): HermeticProc {
  return new HermeticProc(fs);
}
```

### 5.2 Update runtime to pass FS to proc

In `packages/runtime/src/runtime.ts`:
```typescript
const proc = createProc(fs);  // was createProc()
```

### 5.3 Wire shell `node` command to proc

In `packages/shell/src/executor.ts`, when command is `node`:

```typescript
if (name === "node" && args.length > 0) {
  // Route to proc (if proc is available in context)
  // For now, read file and eval inline with captured console
  const scriptPath = resolvePath(ctx.cwd, args[0]);
  try {
    const code = await ctx.fs.readFile(scriptPath, "utf-8") as string;
    // Simple eval with console capture
    const output: string[] = [];
    const errors: string[] = [];
    const fakeConsole = {
      log: (...a: unknown[]) => output.push(a.map(String).join(" ")),
      error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
      warn: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
      info: (...a: unknown[]) => output.push(a.map(String).join(" ")),
    };
    const fn = new Function("console", "process", code);
    fn(fakeConsole, { env: ctx.env, argv: ["node", args[0]], exit: () => {} });
    return {
      stdout: output.join("\n") + (output.length ? "\n" : ""),
      stderr: errors.join("\n") + (errors.length ? "\n" : ""),
      exitCode: 0,
    };
  } catch (err: any) {
    return { stdout: "", stderr: `${err.message}\n`, exitCode: 1 };
  }
}
```

**VERIFY:**
- [ ] `node script.js` actually executes the file's code
- [ ] `console.log` output appears in stdout
- [ ] Errors appear in stderr with stack traces
- [ ] `process.exit(1)` sets correct exit code
- [ ] Worker terminates properly on completion
- [ ] `kill()` still terminates running processes
- [ ] `pnpm build && pnpm test` passes

---

## Step 6: FileSystemObserver Integration

**Problem:** `packages/fs/src/watch.ts` detects `FileSystemObserver` availability but never uses it. Only the polling fallback exists.

Add the actual FileSystemObserver implementation:

```typescript
export function createNativeWatcher(
  dirHandle: FileSystemDirectoryHandle,
  callback: WatchCallback,
): { stop: () => void } | null {
  if (!hasFileSystemObserver()) return null;

  try {
    // @ts-expect-error — FileSystemObserver is not yet in TS lib types
    const observer = new FileSystemObserver(async (records: any[]) => {
      for (const record of records) {
        const path = record.relativePathComponents.join("/");
        const type: WatchEventType =
          record.type === "appeared" ? "create" :
          record.type === "disappeared" ? "delete" :
          record.type === "modified" ? "modify" :
          "modify"; // default
        callback({ type, path: "/" + path });
      }
    });

    observer.observe(dirHandle, { recursive: true });
    return {
      stop: () => observer.disconnect(),
    };
  } catch {
    return null; // Fall back to polling
  }
}
```

Wire this into `packages/fs/src/backends/opfs.ts` — when initializing the OPFS backend, try FileSystemObserver first, fall back to polling:

```typescript
async initWatching(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  this.nativeWatcher = createNativeWatcher(root, (event) => {
    // Forward to registered watchers
    this.watchers.get(event.path)?.forEach(cb => cb(event));
    // Also check wildcard watchers
    this.watchers.get("/")?.forEach(cb => cb(event));
  });

  if (!this.nativeWatcher) {
    // Polling fallback (existing implementation)
    this.watchInterval = setInterval(() => this.pollChanges(), 500);
  }
}
```

**VERIFY:**
- [ ] FileSystemObserver used when available (Chrome 129+)
- [ ] Polling fallback works in Firefox/Safari
- [ ] Watch events fire on file create/modify/delete
- [ ] Unsubscribe stops observation
- [ ] `pnpm build && pnpm test` passes

---

## Step 7: Security Hardening

### 7.1 Fetch Shim URL Validation

**Problem:** `packages/net/src/shims/fetch-shim.ts` — the `shouldIntercept()` function has loose validation. A URL like `javascript:alert(1)` or `data:text/html,...` would be passed to real fetch.

Add protocol validation:

```typescript
function shouldIntercept(url) {
  // Always block dangerous protocols
  if (/^(javascript|data|blob|vbscript):/i.test(url)) {
    return true; // intercept = route to handler, not real fetch
  }
  // ... rest of existing logic ...
}
```

### 7.2 Worker Resource Limits

**Problem:** No limits on Worker creation. Malicious code could spawn thousands of Workers (fork bomb).

In `packages/proc/src/proc.ts`, add limits:

```typescript
private static readonly MAX_PROCESSES = 50;
private static readonly MAX_CONCURRENT = 10;

spawn(command: string, args: string[] = [], options: SpawnOptions = {}): ProcessHandle {
  const running = [...this.processes.values()].filter(p => p.status === "running").length;
  if (running >= HermeticProc.MAX_CONCURRENT) {
    throw new Error("Too many concurrent processes (max 10)");
  }
  if (this.processes.size >= HermeticProc.MAX_PROCESSES) {
    // Clean up exited processes
    for (const [pid, proc] of this.processes) {
      if (proc.status !== "running") this.processes.delete(pid);
    }
    if (this.processes.size >= HermeticProc.MAX_PROCESSES) {
      throw new Error("Process table full (max 50)");
    }
  }
  // ... rest of spawn ...
}
```

### 7.3 Execution Timeout for Workers

Add a default timeout for process execution (prevents infinite loops from hanging forever):

```typescript
spawn(command: string, args: string[] = [], options: SpawnOptions = {}): ProcessHandle {
  // ... existing setup ...

  const timeout = options.timeout ?? 30_000; // 30 second default
  const killTimer = setTimeout(() => {
    if (record.status === "running") {
      this.kill(pid);
    }
  }, timeout);

  // Clear timeout when process exits normally
  const origNotify = this.notifyWaiters.bind(this);
  // (wire clearTimeout into exit handler)
}
```

### 7.4 CSP Verification Test

Create `packages/net/tests/security.browser.test.ts`:

```typescript
describe("Sandbox Security", () => {
  it("iframe has opaque origin", async () => {
    const handle = await createPreview({ handler: () => new Response("ok") });
    // The iframe should NOT have access to parent's origin
    // This test verifies allow-same-origin is NOT present
    expect(handle.iframe.sandbox.contains("allow-same-origin")).toBe(false);
    expect(handle.iframe.sandbox.contains("allow-scripts")).toBe(true);
    handle.dispose();
  });

  it("iframe CSP blocks direct network", async () => {
    // Verify connect-src 'none' is in the CSP
    const handle = await createPreview({ handler: () => new Response("ok") });
    const srcdoc = handle.iframe.srcdoc;
    expect(srcdoc).toContain("connect-src 'none'");
    handle.dispose();
  });

  it("external fetch from iframe is blocked by CSP", async () => {
    // This is a browser-mode test — verify real behavior
  });
});
```

### 7.5 Message Origin Validation

In `packages/net/src/shims/fetch-shim.ts`, validate message origins in the shim:

```typescript
window.addEventListener("message", function(event) {
  // Only accept messages from parent (no origin check possible with opaque origin,
  // but verify message structure)
  if (!event.data || typeof event.data !== "object") return;
  if (event.data.type !== "hermetic-net-init" &&
      event.data.type !== "hermetic-set-content" &&
      event.data.type !== "hermetic-navigate") return;
  // ... existing handler ...
});
```

### 7.6 Input Sanitization for Shell

Prevent shell injection through environment variables or file content used in redirects:

```typescript
// In executor.ts, sanitize redirect targets
function sanitizeRedirectTarget(target: string): string {
  // Prevent path traversal beyond root
  const normalized = normalizePath(target);
  if (normalized.includes("..")) {
    // After normalization, ".." should be gone.
    // If it somehow isn't, reject.
    throw new Error("Invalid redirect target");
  }
  return normalized;
}
```

**VERIFY:**
- [ ] `javascript:` and `data:` URLs are intercepted, not passed to real fetch
- [ ] Worker creation fails after MAX_CONCURRENT limit
- [ ] Process table cleanup works
- [ ] Execution timeout kills runaway Workers
- [ ] Sandbox iframe has correct attributes and CSP
- [ ] All security tests pass
- [ ] `pnpm build && pnpm test` passes

---

## Step 8: Performance Optimization

### 8.1 OPFS Handle Caching

**Problem:** Every `readFile`, `stat`, and `readdir` navigates the directory tree from root. For deep paths, this means 5+ async `getDirectoryHandle()` calls per operation.

Add directory handle caching in `packages/fs/src/opfs-worker.ts`:

```typescript
// LRU cache for directory handles
const dirCache = new Map<string, { handle: FileSystemDirectoryHandle; ts: number }>();
const DIR_CACHE_MAX = 200;
const DIR_CACHE_TTL = 60_000; // 1 minute

async function navigateToDir(path: string): Promise<FileSystemDirectoryHandle> {
  const normalized = normPath(path);

  // Check cache
  const cached = dirCache.get(normalized);
  if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) {
    return cached.handle;
  }

  // Navigate from closest cached ancestor
  const parts = splitPath(normalized);
  let dir = opfsRoot;
  let resolvedPath = "/";

  for (let i = 0; i < parts.length; i++) {
    resolvedPath += (i > 0 ? "/" : "") + parts[i];
    const ancestor = dirCache.get(resolvedPath);
    if (ancestor && Date.now() - ancestor.ts < DIR_CACHE_TTL) {
      dir = ancestor.handle;
      continue;
    }
    dir = await dir.getDirectoryHandle(parts[i]);
    // Cache this handle
    if (dirCache.size >= DIR_CACHE_MAX) {
      // Evict oldest
      let oldestKey = "";
      let oldestTs = Infinity;
      for (const [key, val] of dirCache) {
        if (val.ts < oldestTs) { oldestTs = val.ts; oldestKey = key; }
      }
      dirCache.delete(oldestKey);
    }
    dirCache.set(resolvedPath, { handle: dir, ts: Date.now() });
  }

  return dir;
}

// Invalidate cache on write/delete/rename operations
function invalidateCache(path: string): void {
  const normalized = normPath(path);
  for (const key of dirCache.keys()) {
    if (key.startsWith(normalized) || normalized.startsWith(key)) {
      dirCache.delete(key);
    }
  }
}
```

Call `invalidateCache()` in `writeFile`, `mkdir`, `unlink`, `rmdir`, and `rename`.

### 8.2 Batch Operations

Add batch RPC support to `HermeticChannel` for operations like "read 10 files":

In `packages/core/src/channel.ts`:

```typescript
/**
 * Execute multiple calls in parallel, returning results in order.
 * Much faster than sequential calls due to reduced round-trip overhead.
 */
async batch<T>(calls: Array<{ ns: string; method: string; args: unknown[] }>): Promise<T[]> {
  return Promise.all(
    calls.map((c) => this.call(c.ns, c.method, c.args) as Promise<T>)
  );
}
```

### 8.3 ArrayBuffer Pool for Small Reads

Reduce GC pressure for frequent small file reads:

```typescript
// In opfs-worker.ts
const bufferPool: ArrayBuffer[] = [];
const POOL_SIZE = 32;
const POOL_BUFFER_SIZE = 4096; // 4KB

function getBuffer(size: number): ArrayBuffer {
  if (size <= POOL_BUFFER_SIZE && bufferPool.length > 0) {
    return bufferPool.pop()!;
  }
  return new ArrayBuffer(Math.max(size, POOL_BUFFER_SIZE));
}

// Note: transferred buffers can't be returned to pool (neutered)
// Only pool non-transferred buffers used for intermediate operations
```

### 8.4 Debounce File Watching

In `packages/fs/src/watch.ts`, debounce rapid changes (prevents re-build spam during save):

```typescript
export function createDebouncedWatcher(
  watcher: (cb: WatchCallback) => () => void,
  callback: WatchCallback,
  debounceMs = 100,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: WatchEvent[] = [];

  const flush = () => {
    const events = pending;
    pending = [];
    // Deduplicate: only fire latest event per path
    const latest = new Map<string, WatchEvent>();
    for (const e of events) latest.set(e.path, e);
    for (const event of latest.values()) callback(event);
  };

  return watcher((event) => {
    pending.push(event);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
}
```

### 8.5 Lazy esbuild Initialization

**Problem:** `packages/dev/src/builder.ts` uses `new Function("url", "return import(url)")` for dynamic import. This is a code smell and may fail under strict CSP.

Fix: Use proper dynamic import with a try/catch:

```typescript
async function ensureEsbuild(wasmUrl?: string): Promise<any> {
  if (initialized && esbuildModule) return esbuildModule;

  try {
    // Try local import first (if bundled)
    esbuildModule = await import("esbuild-wasm");
  } catch {
    // Fall back to CDN import
    // @ts-expect-error — dynamic CDN import
    esbuildModule = await import(/* @vite-ignore */ DEFAULT_ESBUILD_CDN);
  }

  await esbuildModule.initialize({
    wasmURL: wasmUrl ?? `${DEFAULT_ESBUILD_CDN}/esbuild.wasm`,
  });
  initialized = true;
  return esbuildModule;
}
```

**VERIFY:**
- [ ] Directory handle caching measurably reduces nested path access time
- [ ] Batch reads are faster than sequential reads
- [ ] File watching debounce prevents rapid re-fires
- [ ] esbuild loads without `new Function()` hack
- [ ] Cache invalidation works (changes visible after write)
- [ ] All tests still pass
- [ ] `pnpm build && pnpm test` passes

---

## Step 9: Comprehensive Test Coverage

**Problem:** Later packages have thin tests. Proc has 36 lines, runtime 40 lines, dev 48 lines.

### 9.1 Proc Tests (`packages/proc/tests/proc.test.ts`)

Expand to cover:
```typescript
describe("HermeticProc", () => {
  it("spawns a process that produces stdout", async () => { ... });
  it("captures stderr from failing script", async () => { ... });
  it("returns correct exit code on success", async () => { ... });
  it("returns exit code 1 on error", async () => { ... });
  it("kill terminates running process with code 137", async () => { ... });
  it("waitpid resolves when process exits", async () => { ... });
  it("waitpid resolves immediately for already-exited process", async () => { ... });
  it("enforces concurrent process limit", async () => { ... });
  it("execution timeout kills runaway process", async () => { ... });
  it("list returns all processes with status", async () => { ... });
  it("dispose kills all running processes", async () => { ... });
});
```

### 9.2 Dev Tests (`packages/dev/tests/builder.test.ts`)

```typescript
describe("HermeticDev Builder", () => {
  it("builds a simple JS file", async () => { ... });
  it("builds TSX with React JSX transform", async () => { ... });
  it("resolves relative imports from HermeticFS", async () => { ... });
  it("resolves bare imports to esm.sh URLs", async () => { ... });
  it("handles missing file gracefully", async () => { ... });
  it("returns errors for syntax errors", async () => { ... });
  it("extension resolution tries .tsx, .ts, .jsx, .js", async () => { ... });
  it("CSS files are extracted separately", async () => { ... });
});
```

### 9.3 Integration Test (`packages/runtime/tests/integration.browser.test.ts`)

Full end-to-end workflow:
```typescript
describe("Hermetic Integration", () => {
  it("full workflow: create → write → build → preview", async () => {
    const hermetic = await Hermetic.create();

    // Write a React app
    await hermetic.fs.writeFile("/app.tsx", `export default function App() { return <h1>Hello</h1>; }`);

    // Build it
    const result = await build(hermetic.fs, "/app.tsx");
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("Hello");

    // Shell command
    const ls = await hermetic.shell.exec("ls /");
    expect(ls.stdout).toContain("app.tsx");

    hermetic.dispose();
  });

  it("shell pipe chain works end-to-end", async () => { ... });
  it("dispose cleans up all resources", async () => { ... });
});
```

### 9.4 OPFS Backend Browser Tests

Create `packages/fs/tests/opfs.browser.test.ts` — mirrors `memory.test.ts` against real OPFS:

```typescript
import { OPFSFS } from "../src/backends/opfs.js";

let fs: OPFSFS;

beforeEach(async () => {
  fs = await OPFSFS.create();
  // Clean OPFS between tests
  const root = await navigator.storage.getDirectory();
  for await (const key of root.keys()) {
    await root.removeEntry(key, { recursive: true });
  }
});

afterEach(() => {
  fs.dispose();
});

// ... same test suite as memory.test.ts ...
```

**VERIFY:**
- [ ] Proc tests cover spawn, kill, timeout, limits, disposal
- [ ] Dev tests cover builds, resolution, errors
- [ ] Integration test covers full create → write → build → execute flow
- [ ] OPFS browser tests mirror memory test suite
- [ ] `pnpm test` passes with significantly more coverage
- [ ] `pnpm test:browser` passes for OPFS and security tests

---

## Step 10: Dev Server ↔ Net Integration

**Problem:** The playground uses direct `srcdoc` injection for preview. The `@hermetic/dev` and `@hermetic/net` subsystems aren't wired together — you can use each independently but not as an integrated dev server.

### 10.1 Create HermeticDevServer

In `packages/dev/src/dev.ts`, add a method that creates a preview using `@hermetic/net`:

```typescript
import { createPreview, type PreviewHandle } from "@hermetic/net";

export class HermeticDev {
  private fs: HermeticFS;
  private preview?: PreviewHandle;
  private unwatchFs?: () => void;

  constructor(fs: HermeticFS) {
    this.fs = fs;
  }

  async startPreview(container: HTMLElement, entry: string): Promise<PreviewHandle> {
    // Build the entry point
    const result = await build(this.fs, entry);

    if (result.errors.length > 0) {
      throw new Error(`Build failed:\n${result.errors.map(e => e.text).join("\n")}`);
    }

    // Create preview with a handler that serves built files and static assets
    this.preview = await createPreview({
      container,
      handler: async (request: Request) => {
        const url = new URL(request.url);
        const path = url.pathname;

        // Serve built JS
        if (path === "/" || path === "/index.html") {
          const html = generateHTML(result.code, result.css);
          return new Response(html, {
            headers: { "content-type": "text/html" },
          });
        }

        // Serve static files from FS
        try {
          const content = await this.fs.readFile(path);
          const mime = guessMimeType(path);
          return new Response(content, {
            headers: { "content-type": mime },
          });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      },
    });

    // Watch for changes and rebuild
    this.unwatchFs = this.fs.watch("/", async (event) => {
      if (event.type === "modify" || event.type === "create") {
        try {
          const rebuilt = await build(this.fs, entry);
          if (rebuilt.errors.length === 0 && this.preview) {
            // Send HMR update
            const html = generateHTML(rebuilt.code, rebuilt.css);
            this.preview.setContent(html);
          }
        } catch {}
      }
    });

    return this.preview;
  }

  dispose(): void {
    this.unwatchFs?.();
    this.preview?.dispose();
  }
}

function generateHTML(code: string, css?: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
${css ? `<style>${css}</style>` : ""}
</head><body>
<div id="root"></div>
<script type="module">${code}</script>
</body></html>`;
}
```

### 10.2 Update Playground to Use Integrated Dev Server

In `apps/playground/src/main.ts`, replace the manual `updatePreview()` with `HermeticDev.startPreview()`:

```typescript
import { HermeticDev } from "@hermetic/dev";

let dev: HermeticDev;

async function init() {
  fs = new MemoryFS();
  shell = new HermeticShell(fs, { cwd: "/" });
  dev = new HermeticDev(fs);

  // ... seed files ...

  // Start integrated dev server
  await dev.startPreview(previewContainer, "/index.js");
}
```

**VERIFY:**
- [ ] Preview serves built code through MessageChannel routing
- [ ] Static files from FS are servable through preview fetch
- [ ] File changes trigger rebuild + preview update
- [ ] Preview iframe still has correct sandbox/CSP attributes
- [ ] Playground works with integrated dev server
- [ ] `pnpm build && pnpm test` passes

---

## Step 11: Documentation & README

### 11.1 Root README.md

Write a comprehensive README covering:
- What Hermetic is (one paragraph)
- Architecture diagram (ASCII)
- Quick start code example
- Package list with one-line descriptions
- Browser compatibility
- Security model summary
- License (MIT)

### 11.2 Per-Package READMEs

Each package README should have:
- Purpose (one sentence)
- Install command
- Basic usage example
- API reference (exported types and functions)
- Browser compatibility notes

### 11.3 SECURITY.md

Document the security model:
- Isolation layers (sandbox iframe, CSP, Worker, capabilities)
- What user code CAN and CANNOT do
- Patent avoidance summary
- Responsible disclosure process

### 11.4 ARCHITECTURE.md

Create a single architecture document with:
- System diagram (Host ↔ MessageChannel ↔ Sandbox)
- Data flow for key operations (readFile, fetch, spawn)
- Package dependency graph
- Extension points

**VERIFY:**
- [ ] README has working quick start example
- [ ] Every package has a README
- [ ] SECURITY.md documents all isolation layers
- [ ] ARCHITECTURE.md has clear diagrams

---

## Final Verification

Run the full suite:

```bash
pnpm build          # All packages compile
pnpm typecheck      # Zero TS errors
pnpm test           # All unit tests pass
pnpm test:browser   # All browser tests pass
```

### Security Checklist (re-verify everything)

- [ ] Sandbox iframe has NO `allow-same-origin`
- [ ] CSP blocks `connect-src` in sandbox
- [ ] Workers inside sandbox use Blob URLs only
- [ ] User code cannot access `window.parent` / `window.top`
- [ ] User code cannot read host page cookies/localStorage
- [ ] fetch() routes through capability binding (host audits all requests)
- [ ] OPFS handles never exposed to user code
- [ ] Worker termination kills execution (infinite loops stop)
- [ ] Process limits enforced (max 10 concurrent, 50 total)
- [ ] Execution timeout kills runaway Workers (30s default)
- [ ] No Service Workers registered anywhere
- [ ] No cross-origin iframes created anywhere
- [ ] All MessageChannel messages branded (`__hermetic: true`)
- [ ] `javascript:` and `data:` URLs blocked in fetch shim
- [ ] Redirect targets sanitized in shell

### Performance Checklist

- [ ] OPFS directory handle cache working
- [ ] Concurrent reads use `read-only` mode (no unnecessary locks)
- [ ] File watching debounced (no rebuild spam)
- [ ] esbuild initialized lazily (not on import)
- [ ] ArrayBuffer transfer (not copy) for file reads and network responses

### Completeness Checklist

- [ ] All three FS backends: OPFS, IndexedDB, memory
- [ ] Shell pipes actually pipe (not just string concat)
- [ ] Glob expansion works (*.js, ?, **)
- [ ] `node script.js` executes the script
- [ ] FileSystemObserver used when available
- [ ] Dev server integrated with Net (MessageChannel routing)
- [ ] Playground uses integrated dev server
- [ ] All packages have >80% test coverage for core functionality
