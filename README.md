# Hermetic

A complete, sandboxed development environment that runs entirely in the browser. Hermetic provides an isolated virtual filesystem, shell, process model, package manager, and dev server — all communicating through secure MessageChannel-based protocols with no network access from sandboxed code.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Host Page                                          │
│  ┌───────────────────────────────────────────────┐  │
│  │  @hermetic/runtime                            │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐        │  │
│  │  │   fs    │ │  shell  │ │   vm    │        │  │
│  │  │ (OPFS/  │ │ (bash-  │ │ (cap-   │        │  │
│  │  │  IDB/   │ │  like)  │ │  able)  │        │  │
│  │  │  mem)   │ │         │ │         │        │  │
│  │  └────┬────┘ └─────────┘ └─────────┘        │  │
│  │       │      ┌─────────┐ ┌─────────┐        │  │
│  │       │      │  proc   │ │   pm    │        │  │
│  │       │      │ (Worker │ │ (npm    │        │  │
│  │       │      │  pool)  │ │  compat)│        │  │
│  │       │      └─────────┘ └─────────┘        │  │
│  │       │                                      │  │
│  │  ═════╪═══ MessageChannel ═══════════════    │  │
│  │       │                                      │  │
│  │  ┌────┴──────────────────────────────────┐   │  │
│  │  │  Sandbox iframe (allow-scripts only)  │   │  │
│  │  │  ┌──────────┐  ┌──────────────────┐   │   │  │
│  │  │  │ @hermetic│  │  User code       │   │   │  │
│  │  │  │ /net     │  │  (isolated)      │   │   │  │
│  │  │  │ (fetch   │  │                  │   │   │  │
│  │  │  │  shim)   │  │                  │   │   │  │
│  │  │  └──────────┘  └──────────────────┘   │   │  │
│  │  └───────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Quick Start

```typescript
import { Hermetic } from "@hermetic/runtime";

const runtime = await Hermetic.create();

// Write files to the virtual filesystem
await runtime.fs.writeFile("/hello.js", 'console.log("Hello, Hermetic!")');

// Execute shell commands
const result = await runtime.shell.exec("cat /hello.js | grep Hello");
console.log(result.stdout); // 'console.log("Hello, Hermetic!")\n'

// Run scripts
const run = await runtime.shell.exec("node /hello.js");
console.log(run.stdout); // "Hello, Hermetic!\n"

// Clean up
runtime.dispose();
```

## Packages

| Package | Description |
|---------|-------------|
| `@hermetic/core` | Protocol, channel, utilities shared across all packages |
| `@hermetic/fs` | Virtual filesystem with OPFS, IndexedDB, and memory backends |
| `@hermetic/vm` | Capability-based sandbox VM with binding system |
| `@hermetic/proc` | Process model using Web Workers with resource limits |
| `@hermetic/shell` | Bash-like shell with piping, globs, and builtins |
| `@hermetic/pm` | Package manager with npm-compatible registry support |
| `@hermetic/net` | Sandboxed networking via MessageChannel with fetch shim |
| `@hermetic/dev` | Dev server with esbuild-wasm builds and HMR |
| `@hermetic/runtime` | Facade that wires all subsystems into a single runtime |

## Browser Compatibility

| Feature | Chrome | Firefox | Safari |
|---------|--------|---------|--------|
| Core runtime | 90+ | 90+ | 15+ |
| OPFS backend | 102+ | 111+ | 15.2+ |
| IndexedDB backend | All | All | All |
| FileSystemObserver | 129+ | — | — |
| Read-only access handles | 121+ | — | — |

## Security Model

Hermetic isolates user code through multiple layers:

1. **Sandbox iframe** — `allow-scripts` only (no `allow-same-origin`)
2. **Content Security Policy** — `connect-src 'none'` blocks direct network
3. **MessageChannel routing** — All I/O goes through auditable host-side handlers
4. **Worker isolation** — Process execution in dedicated Workers with timeout/limits
5. **Capability bindings** — Only explicitly granted APIs are available to sandboxed code

User code **cannot**: access cookies, localStorage, parent window, real network, or host-page DOM.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
