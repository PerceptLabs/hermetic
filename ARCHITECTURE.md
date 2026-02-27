# Architecture

## System Diagram

```
┌──────────────── Host Page ────────────────────────────────────────────┐
│                                                                       │
│  @hermetic/runtime (facade)                                          │
│    │                                                                  │
│    ├── @hermetic/fs                                                   │
│    │     ├── MemoryFS (default in tests)                             │
│    │     ├── OPFSFS ──────── Worker ──── OPFS Storage                │
│    │     │     └── HermeticChannel (port1 ↔ port2)                   │
│    │     └── IndexedDBFS ─── IDB transactions                        │
│    │                                                                  │
│    ├── @hermetic/shell                                               │
│    │     ├── Parser (bash-like AST)                                  │
│    │     ├── Executor (pipeline, redirects, globs)                   │
│    │     └── Builtins (echo, ls, cat, grep, sort, find, ...)        │
│    │                                                                  │
│    ├── @hermetic/proc                                                │
│    │     └── Web Worker pool (node emulation, timeouts, limits)      │
│    │                                                                  │
│    ├── @hermetic/vm                                                  │
│    │     └── Capability bindings (register/invoke)                   │
│    │                                                                  │
│    └── @hermetic/pm                                                  │
│          └── npm registry client + tar parser                        │
│                                                                       │
│  ════════════════ MessageChannel ══════════════════════════════       │
│                                                                       │
│  ┌─── Sandbox iframe (allow-scripts) ───────────────────────┐        │
│  │  @hermetic/net                                           │        │
│  │    ├── fetch-shim.ts (overrides window.fetch)            │        │
│  │    ├── location-shim.ts (virtual location)               │        │
│  │    └── cookie-shim.ts (no-op cookies)                    │        │
│  │                                                           │        │
│  │  User code (fully isolated)                              │        │
│  └───────────────────────────────────────────────────────────┘        │
│                                                                       │
│  @hermetic/dev                                                       │
│    ├── esbuild-wasm builder (lazy loaded from CDN)                   │
│    ├── HMR client (full-page reload via postMessage)                 │
│    └── Preview integration (uses @hermetic/net)                      │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Data Flow: readFile

```
User code (iframe)
  │ fetch("/api/fs/read?path=/app.js")
  ▼
fetch-shim intercepts
  │ port.postMessage({ type: "fetch", url: "/api/fs/read?path=/app.js" })
  ▼
Host router (port2.onmessage)
  │ handler(new Request(...))
  ▼
Handler reads from HermeticFS
  │ fs.readFile("/app.js")
  ▼
  ├── MemoryFS: Map lookup, returns data
  ├── OPFSFS: channel.call("fs", "readFile", ["/app.js"])
  │     └── Worker: navigateToFile() → createSyncAccessHandle() → read()
  └── IndexedDBFS: IDB transaction → get by path key
  │
  ▼
Response sent back through port
  │ port2.postMessage({ type: "fetch-response", body: ... })
  ▼
fetch-shim resolves Promise
  │ new Response(body, { status: 200 })
  ▼
User code receives Response
```

## Data Flow: Shell Command Execution

```
shell.exec("cat /data.txt | sort | head -n5")
  │
  ▼
Parser → AST: Pipeline([cat /data.txt, sort, head -n5])
  │
  ▼
Executor.executePipeline()
  │
  ├─ Stage 1: cat /data.txt
  │    └── builtin: fs.readFile("/data.txt") → stdout
  │
  ├─ Stage 2: sort (stdin = stage 1 stdout)
  │    └── builtin: lines.sort() → stdout
  │
  └─ Stage 3: head -n5 (stdin = stage 2 stdout)
       └── builtin: lines.slice(0, 5) → stdout
  │
  ▼
Final result: { stdout, stderr, exitCode }
```

## Data Flow: Process Spawn

```
proc.spawn("node", ["script.js"])
  │
  ▼
HermeticProc.spawn()
  ├── Check limits (MAX_CONCURRENT=10, MAX_PROCESSES=50)
  ├── fs.readFile("script.js") → user code string
  ├── generateNodeWorkerCode(userCode)
  │     └── Wraps with: console shim, process shim, try/catch
  ├── new Blob([workerCode]) → URL.createObjectURL()
  ├── new Worker(blobUrl)
  └── setTimeout(kill, 30000) // execution timeout
  │
  ▼
Worker executes user code
  ├── console.log("...") → postMessage({ type: "stdout" })
  ├── throw Error → postMessage({ type: "stderr" }) + ({ type: "exit", code: 1 })
  └── Normal exit → postMessage({ type: "exit", code: 0 })
  │
  ▼
Host collects stdout/stderr via TransformStream
```

## Package Dependency Graph

```
@hermetic/core (zero deps)
  ├── @hermetic/fs
  ├── @hermetic/vm
  ├── @hermetic/net
  ├── @hermetic/proc (+ @hermetic/fs)
  ├── @hermetic/pm (+ @hermetic/fs)
  ├── @hermetic/shell (+ @hermetic/fs)
  ├── @hermetic/dev (+ @hermetic/fs, @hermetic/net)
  └── @hermetic/runtime (all packages)
```

## Extension Points

1. **Custom FS backends** — Implement the `HermeticFS` interface
2. **Custom shell builtins** — Add entries to the `builtins` record
3. **Custom fetch handlers** — Pass a `ServerHandler` to `createPreview()`
4. **Custom VM bindings** — Register capabilities via `vm.register()`
5. **Custom process commands** — Extend `generateWorkerCode()` for new runtimes
