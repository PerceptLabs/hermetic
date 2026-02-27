# Hermetic: Claude Code Build Playbook

**You have two reference documents. Read them BOTH before writing any code:**

1. `hermetic-spec.md` — The WHAT. Architecture, design principles, API surfaces, patent avoidance. This is the authoritative source of truth for all design decisions.
2. `hermetic-cc-plan.md` — The HOW. File-by-file implementation details, code samples, edge cases, error handling patterns, bootstrap sequences.

**Rules:**
- Follow the steps below IN ORDER. Do not skip ahead.
- Each step has a VERIFY gate. Do not proceed to the next step until verification passes.
- Every package must build, typecheck, and pass tests independently.
- NEVER use SharedArrayBuffer, Service Workers for networking, or cross-origin iframes. See patent avoidance in the spec.
- NEVER reference WebContainers source code, documentation, or implementation details. Clean-room only.
- When in doubt, the spec document wins. When the spec is silent, the CC plan wins. When both are silent, ask.

---

## Step 0: Monorepo Scaffold

Create the monorepo structure exactly as described in CC plan section 0.

```
hermetic/
├── packages/
│   ├── core/
│   ├── fs/
│   ├── vm/
│   ├── proc/
│   ├── pm/
│   ├── shell/
│   ├── net/
│   ├── dev/
│   └── runtime/
├── apps/
│   └── playground/
├── package.json          (workspace root, pnpm)
├── pnpm-workspace.yaml
├── tsconfig.json         (base config)
└── README.md
```

For each package under `packages/`, create:
- `package.json` with `@hermetic/{name}` naming, ESM + CJS exports
- `tsconfig.json` extending root
- `tsup.config.ts` for builds
- `src/index.ts` (empty export for now)
- `tests/` directory

Install dev dependencies at root: typescript, tsup, vitest, @vitest/browser, eslint, prettier.

**VERIFY:**
- [ ] `pnpm install` succeeds
- [ ] `pnpm -r build` succeeds (all packages produce dist/)
- [ ] `pnpm -r typecheck` has no errors
- [ ] Each package can be imported by name from another package

---

## Step 1: @hermetic/core

Read CC plan section 1. Implement:

1. **`src/types.ts`** — Core type definitions used everywhere
2. **`src/protocol.ts`** — The MessageChannel wire protocol. Discriminated union message types. `SerializedError` type. `serializeError()` and `deserializeError()` functions. This is the most important file in the project.
3. **`src/channel.ts`** — `HermeticChannel` class. RPC-over-MessageChannel. Request/response correlation with `crypto.randomUUID()`. Timeout handling. Error propagation. Handler registration. Notification events. Disposal.
4. **`src/errors.ts`** — `HermeticError` base class. POSIX error codes (ENOENT, EISDIR, EACCES, ENOTEMPTY, EBUSY, EIO).
5. **`src/disposable.ts`** — `Disposable` interface. `DisposableStore` for cleanup.
6. **`src/utils.ts`** — `normalizePath()`, `joinPath()`, `dirname()`, `basename()`, `extname()`, `resolvePath()`, `guessMimeType()`. Pure functions, no Node.js imports, POSIX semantics only.
7. **`src/index.ts`** — Re-export everything.

Write tests:
- `tests/channel.test.ts` — Full test suite for HermeticChannel using real MessageChannel pairs
- `tests/utils.test.ts` — Path normalization edge cases
- `tests/protocol.test.ts` — Error serialization round-trips

**VERIFY:**
- [ ] `pnpm build` in packages/core succeeds
- [ ] `pnpm test` in packages/core — all tests pass
- [ ] HermeticChannel can send request → receive response across MessageChannel
- [ ] HermeticChannel propagates errors correctly across boundary
- [ ] HermeticChannel times out on unresponsive handlers
- [ ] HermeticChannel rejects all pending on dispose
- [ ] Path utilities handle edge cases: double slashes, trailing slashes, `.`, `..`, root

---

## Step 2: @hermetic/fs — Memory Backend

Read CC plan section 2. Start with the MEMORY backend only (no Workers, no OPFS yet).

1. **`src/types.ts`** — `HermeticFS` interface, `FileStat`, `FSOptions`, `WatchCallback`
2. **`src/backends/memory.ts`** — Complete in-memory filesystem using `Map<string, FileNode>`. Implement ALL methods from the HermeticFS interface: readFile, writeFile, mkdir, readdir, rmdir, stat, lstat, chmod, utimes, symlink, readlink, rename, unlink, copyFile, exists, watch.
3. **`src/index.ts`** — `createFS()` factory that returns memory backend.

Write thorough tests against the memory backend:
- `tests/memory.test.ts` — Test every filesystem operation
- Test error cases: ENOENT on missing files, EISDIR on readFile of directory, ENOTEMPTY on rmdir of non-empty dir, recursive mkdir, recursive rmdir
- Test symlink resolution (up to 40 hops, then ELOOP)
- Test path edge cases

**VERIFY:**
- [ ] All HermeticFS interface methods implemented for memory backend
- [ ] All tests pass
- [ ] Error codes match POSIX conventions (ENOENT, EISDIR, etc.)
- [ ] The memory backend works as ground truth for future OPFS testing

---

## Step 3: @hermetic/fs — OPFS Backend

Now add the OPFS backend. Read CC plan section 2.2-2.5 carefully — OPFS handle lifecycle is the trickiest part.

1. **`src/opfs-worker.ts`** — The dedicated Worker script. Must be SELF-CONTAINED (no imports from other packages). Handles: readFile, writeFile, mkdir, readdir, rmdir, stat, unlink, rename, exists, copyFile. Maps DOMException to POSIX error codes. ALWAYS closes access handles in finally blocks.
2. **`src/backends/opfs.ts`** — Main-thread wrapper. Creates the OPFS Worker (from bundled string or Blob URL). Uses HermeticChannel for RPC. Implements HermeticFS interface by delegating to Worker.
3. **`src/watch.ts`** — File watching. Use FileSystemObserver when available (`'FileSystemObserver' in globalThis`), fall back to polling at 500ms.
4. Update `createFS()` to auto-detect OPFS support and select backend.

Write browser-mode tests:
- `tests/opfs.browser.test.ts` — Run in vitest browser mode (needs real browser for OPFS)
- Test the same operations as memory backend
- Test concurrent reads (if `readwrite-unsafe` available)
- Test that access handles are properly released (no EBUSY from leaked handles)

**VERIFY:**
- [ ] OPFS backend passes same test suite as memory backend
- [ ] Access handles are always closed (no leaked locks)
- [ ] DOMException errors map correctly to POSIX codes
- [ ] FileSystemObserver used when available, polling fallback works
- [ ] `createFS()` auto-selects OPFS in browser, memory in Node/test

---

## Step 4: @hermetic/net

Read CC plan section 3. Pay VERY careful attention to the bootstrap sequence timing.

1. **`src/shims/fetch-shim.ts`** — The fetch override injected into preview iframe. Intercepts relative/localhost URLs, routes through MessageChannel port. Passes external URLs through to real fetch. Handles streaming responses.
2. **`src/shims/location-shim.ts`** — Virtual `window.location` and `history.pushState` override.
3. **`src/shims/cookie-shim.ts`** — Virtual `document.cookie` jar.
4. **`src/router.ts`** — Host-side request router. Reconstructs Request objects from MessageChannel messages. Calls server handler `(Request) => Response`. Serializes Response back. Handles streaming.
5. **`src/preview.ts`** — `createPreview()`. Creates sandbox iframe (`sandbox="allow-scripts"`, NO `allow-same-origin`). Bundles shim code into srcdoc. Creates MessageChannel. Transfers port to iframe on load event. Returns PreviewHandle.
6. **`src/index.ts`** — Public API.

The shim files must be bundled as string constants (they run INSIDE the iframe, not on the host).

Write tests:
- `tests/net.browser.test.ts` — Create preview, verify fetch inside iframe routes to handler
- Test that iframe cannot access parent window (opaque origin)
- Test streaming responses
- Test error responses (handler throws)

**VERIFY:**
- [ ] Preview iframe has opaque origin (no `allow-same-origin`)
- [ ] CSP on iframe blocks direct network (`connect-src 'none'`)
- [ ] fetch("/api/test") inside preview routes to host handler
- [ ] Host handler receives proper Request object
- [ ] Response correctly serialized back to preview
- [ ] Streaming responses work (chunks flow through MessageChannel)
- [ ] External URLs (https://cdn.example.com) pass through to real fetch
- [ ] Port transfer happens AFTER iframe load (no race condition)

---

## Step 5: @hermetic/vm

Read CC plan section 4.

1. **`src/bindings.ts`** — Generate capability binding code (fetch, console, fs bindings as string). This code gets prepended to user code inside Workers.
2. **`src/context.ts`** — `ExecutionContext` class. Creates a Worker inside the sandbox iframe from Blob URL with bindings prepended. Routes capability requests back to host via MessageChannel.
3. **`src/module-loader.ts`** — ES module resolution: relative imports → HermeticFS, bare specifiers → esm.sh CDN, .ts/.tsx → esbuild-wasm transpile.
4. **`src/vm.ts`** — `HermeticVM` class. `eval()` and `createContext()` methods.
5. **`src/index.ts`** — Public API.

Write tests:
- `tests/vm.browser.test.ts` — Eval simple code, verify console capture, verify fetch routing through capability binding, verify Worker termination stops execution

**VERIFY:**
- [ ] User code runs inside Worker inside sandbox iframe (double isolation)
- [ ] User code can only fetch through capability binding, not raw fetch
- [ ] console.log in user code is captured and forwarded to host
- [ ] Worker can be terminated (infinite loop stops)
- [ ] eval() returns results correctly across boundaries

---

## Step 6: @hermetic/dev

Read CC plan section 5.

1. **`src/builder.ts`** — esbuild-wasm integration. Initialize wasm once. Custom plugin that resolves imports from HermeticFS (relative) and esm.sh (bare specifiers).
2. **`src/hmr.ts`** — HMR client code (injected into preview). React Fast Refresh wrapper.
3. **`src/dev.ts`** — `HermeticDev` class. Watches HermeticFS for changes. Rebuilds affected modules. Sends HMR updates to preview via MessageChannel.
4. **`src/templates/html-template.ts`** — Default HTML wrapper for preview.
5. **`src/index.ts`** — Public API.

Write tests:
- `tests/builder.test.ts` — Build a simple React app from HermeticFS files
- `tests/dev.browser.test.ts` — Start dev server, verify preview renders, modify file, verify HMR update

**VERIFY:**
- [ ] esbuild-wasm initializes and builds successfully
- [ ] Custom plugin resolves from HermeticFS
- [ ] Bare imports resolve to esm.sh CDN URLs
- [ ] TSX/JSX compilation works
- [ ] Preview shows built application
- [ ] File change triggers rebuild + HMR update

---

## Step 7: @hermetic/pm

Read CC plan section 6.

1. **`src/tar-parser.ts`** — Pure JS tar parser from POSIX.1-2001 spec. ~200 lines. Strips `package/` prefix.
2. **`src/registry.ts`** — npm registry HTTP client. GET packument, GET version, fetch tarball.
3. **`src/resolver.ts`** — Dependency tree resolution. Semver range resolution. Flat node_modules layout (npm v3+ hoisting).
4. **`src/tarball.ts`** — Fetch tarball → DecompressionStream("gzip") → tar parser → write to HermeticFS.
5. **`src/cdn.ts`** — esm.sh CDN resolution. Fast path that skips local install.
6. **`src/cache.ts`** — IndexedDB cache for downloaded packages.
7. **`src/lockfile.ts`** — package-lock.json v3 read/write.
8. **`src/pm.ts`** — `HermeticPM` class. `install()`, `uninstall()`, `exec()` methods.
9. **`src/index.ts`** — Public API.

Write tests:
- `tests/tar-parser.test.ts` — Parse a known tar file, verify entries
- `tests/resolver.test.ts` — Resolve dependency trees from mock packuments
- `tests/pm.browser.test.ts` — Install a real small package (e.g., `is-odd`), verify files in HermeticFS

**VERIFY:**
- [ ] Tar parser correctly extracts files from gzipped tarballs
- [ ] Dependency resolver handles semver ranges correctly
- [ ] CDN fast path works for simple packages
- [ ] Full install path creates correct node_modules layout
- [ ] Cache prevents duplicate downloads
- [ ] Lockfile produces deterministic installs

---

## Step 8: @hermetic/proc

Read CC plan section 7.

1. **`src/process.ts`** — Process record type. PID allocation. Process table.
2. **`src/proc.ts`** — `HermeticProc` class. `spawn()` creates Worker inside sandbox. `kill()` terminates Worker. `waitpid()` waits for exit. Transferable Streams for stdin/stdout/stderr piping.
3. **`src/index.ts`** — Public API.

Write tests:
- `tests/proc.browser.test.ts` — Spawn a process, capture stdout, verify exit code
- Test pipe between two processes (stdout → stdin)
- Test kill terminates running process

**VERIFY:**
- [ ] spawn() creates isolated Worker
- [ ] stdout/stderr captured correctly
- [ ] Piping between processes works via Transferable Streams
- [ ] kill() terminates Worker
- [ ] waitpid() resolves with exit code

---

## Step 9: @hermetic/shell

Read CC plan section 8.

1. **`src/parser.ts`** — Recursive descent parser for shell syntax. Handles: commands, pipes, redirects, &&/||/;, variables, subshells, globs.
2. **`src/builtins.ts`** — Built-in commands: cd, pwd, ls, cat, echo, mkdir, rm, cp, mv, touch, grep, find, env, export, which, clear, exit.
3. **`src/executor.ts`** — Executes parsed AST. Routes to builtins, known executables (node, npm, git), or HermeticProc for external commands.
4. **`src/glob.ts`** — Glob expansion against HermeticFS.
5. **`src/shell.ts`** — `HermeticShell` class. Maintains environment variables, cwd, command history.
6. **`src/index.ts`** — Public API.

Write tests:
- `tests/parser.test.ts` — Parse various shell commands, verify AST
- `tests/builtins.test.ts` — Test each built-in against HermeticFS
- `tests/shell.browser.test.ts` — Execute multi-command sequences

**VERIFY:**
- [ ] Parser handles pipes, redirects, variables, globs
- [ ] Built-in commands work correctly against HermeticFS
- [ ] `node script.js` routes to HermeticVM
- [ ] `npm install` routes to HermeticPM
- [ ] Pipe chains work (ls | grep | sort)
- [ ] Environment variables persist across commands

---

## Step 10: @hermetic/runtime

Read CC plan section 9.

1. **`src/runtime.ts`** — `Hermetic` facade class. `create()` factory wires all subsystems together. Single `dispose()` cleans everything up.
2. **`src/index.ts`** — Public API.

Write integration tests:
- `tests/runtime.browser.test.ts` — Full workflow: create runtime, write files, install package, start dev server, verify preview

**VERIFY:**
- [ ] `Hermetic.create()` initializes all subsystems
- [ ] Full workflow works end-to-end
- [ ] `dispose()` cleans up all Workers, iframes, channels

---

## Step 11: Playground App

Create `apps/playground/` — a simple web app that demonstrates Hermetic.

- Text editor (textarea or CodeMirror)
- Terminal (xterm.js)
- Preview pane (iframe from HermeticDev)
- File tree sidebar (from HermeticFS.readdir)

This is the demo that proves everything works together.

**VERIFY:**
- [ ] User can write code in editor
- [ ] User can run commands in terminal
- [ ] Preview shows live application
- [ ] File changes trigger HMR updates
- [ ] npm install works from terminal

---

## Final Checklist

- [ ] `pnpm build` succeeds for all packages
- [ ] `pnpm test` passes for all packages
- [ ] `pnpm typecheck` has zero errors
- [ ] No Service Workers used anywhere
- [ ] No cross-origin iframes created anywhere
- [ ] No SharedArrayBuffer dependencies
- [ ] All user code runs inside sandbox iframe + Worker (never on host)
- [ ] All cross-boundary communication uses MessageChannel
- [ ] MIT license in every package
- [ ] README.md in every package with basic usage
