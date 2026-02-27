# Security Model

Hermetic provides a multi-layered security architecture that isolates untrusted user code from the host page and the broader web.

## Isolation Layers

### 1. Sandbox Iframe

User code runs inside an `<iframe>` with the `sandbox` attribute set to `allow-scripts` only. Critically, `allow-same-origin` is **never** set — this gives the iframe an opaque origin, preventing access to:

- Host page cookies and localStorage
- Host page DOM (`window.parent`, `window.top`)
- IndexedDB belonging to the host origin
- Service Worker registration

### 2. Content Security Policy (CSP)

The sandbox iframe includes a strict CSP:

```
script-src 'unsafe-inline' blob:; connect-src 'none';
```

- `connect-src 'none'` blocks all direct network requests (fetch, XHR, WebSocket)
- `script-src 'unsafe-inline' blob:` allows the injected shim code and Worker creation
- No external script loading is permitted

### 3. MessageChannel Routing

All I/O from sandboxed code is routed through a `MessagePort`:

- `fetch()` is shimmed to send requests through the port to the host
- The host-side router can inspect, modify, or reject any request
- All messages are branded with `__hermetic: true` for identification
- Protocol validation rejects malformed messages

### 4. Worker Resource Limits

Processes spawned via `@hermetic/proc` have hard limits:

- **MAX_CONCURRENT**: 10 simultaneous Workers
- **MAX_PROCESSES**: 50 total entries in the process table
- **Execution timeout**: 30 seconds (configurable)
- Workers are terminated on timeout or explicit kill

### 5. Fetch Shim Validation

The fetch shim blocks dangerous URL protocols:

- `javascript:` URLs are intercepted (never passed to real fetch)
- `data:` URLs are intercepted
- `blob:` URLs are intercepted
- `vbscript:` URLs are intercepted
- Only relative URLs and localhost are routed through the MessageChannel

### 6. Shell Input Sanitization

- Redirect targets (`>`, `>>`) are normalized and validated
- Path traversal (`..`) is blocked after normalization
- Environment variable expansion is sandboxed to the shell's own env

## What User Code CAN Do

- Read/write files in the virtual filesystem
- Execute shell commands (ls, cat, grep, etc.)
- Run JavaScript via `node script.js`
- Make fetch requests (routed through host-side handler)
- Create Web Workers (within process limits)

## What User Code CANNOT Do

- Access the host page's cookies, localStorage, or sessionStorage
- Access `window.parent`, `window.top`, or `window.opener`
- Make direct network requests (all go through MessageChannel)
- Register Service Workers
- Read from or write to the host's real filesystem
- Access OPFS handles directly (only through RPC)
- Spawn unlimited Workers (process limits enforced)
- Run code indefinitely (execution timeout enforced)
- Access cross-origin iframes

## Responsible Disclosure

If you discover a security vulnerability in Hermetic, please report it by opening a GitHub issue with the `security` label.
