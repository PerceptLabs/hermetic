// @hermetic/vm — Capability binding generation
//
// Generates the preamble code injected before user code inside Workers.
// This code runs in the Worker context, NOT on the host.

import type { CapabilityFlags } from "./types.js";

/**
 * Generate capability binding code for a Worker.
 * This code sets up sealed versions of fetch, console, fs
 * that route through the MessageChannel port.
 */
export function generateBindings(capabilities: CapabilityFlags = {}): string {
  const parts: string[] = [];

  parts.push(`
// === HERMETIC CAPABILITY BINDINGS ===
let __hermetic_port = null;
const __hermetic_pending = new Map();

// RPC call helper
function __call(ns, method, args) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      __hermetic_pending.delete(id);
      reject(new Error("RPC timeout: " + ns + "." + method));
    }, 30000);
    __hermetic_pending.set(id, { resolve, reject, timeout });
    __hermetic_port.postMessage({ __hermetic: true, ns, id, method, args });
  });
}

// Handle incoming messages (responses and notifications)
function __handleMessage(event) {
  const msg = event.data;
  if (!msg || !msg.__hermetic) return;

  // Response to a pending request
  if ("ok" in msg && msg.id) {
    const pending = __hermetic_pending.get(msg.id);
    if (!pending) return;
    __hermetic_pending.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.ok) pending.resolve(msg.value);
    else pending.reject(new Error(msg.error?.message || "Unknown error"));
    return;
  }
}

// Wait for port transfer
self.addEventListener("message", function(event) {
  if (event.data && event.data.type === "hermetic-vm-init" && event.ports.length > 0) {
    __hermetic_port = event.ports[0];
    __hermetic_port.onmessage = __handleMessage;
    __hermetic_port.start();
  }
});
`);

  if (capabilities.console !== false) {
    parts.push(`
// Sealed console — captured and forwarded to host
const console = {
  log: function() {
    var args = Array.from(arguments).map(String);
    if (__hermetic_port) __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "log", args: args });
  },
  error: function() {
    var args = Array.from(arguments).map(String);
    if (__hermetic_port) __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "error", args: args });
  },
  warn: function() {
    var args = Array.from(arguments).map(String);
    if (__hermetic_port) __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "warn", args: args });
  },
  info: function() {
    var args = Array.from(arguments).map(String);
    if (__hermetic_port) __hermetic_port.postMessage({ __hermetic: true, ns: "vm", event: "console", level: "info", args: args });
  },
};
`);
  }

  if (capabilities.fetch !== false) {
    parts.push(`
// Sealed fetch — routes through capability binding
const fetch = async function(input, init) {
  const request = new Request(input, init);
  const body = await request.arrayBuffer();
  return __call("net", "fetch", [{
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: body.byteLength > 0 ? body : null,
  }]).then(function(result) {
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  });
};
`);
  }

  if (capabilities.fs) {
    parts.push(`
// Sealed fs — routes to HermeticFS via MessageChannel
const fs = {
  readFile: function(path, encoding) { return __call("fs", "readFile", [path, encoding]); },
  writeFile: function(path, data, opts) { return __call("fs", "writeFile", [path, data, opts]); },
  mkdir: function(path, opts) { return __call("fs", "mkdir", [path, opts]); },
  readdir: function(path) { return __call("fs", "readdir", [path]); },
  stat: function(path) { return __call("fs", "stat", [path]); },
  unlink: function(path) { return __call("fs", "unlink", [path]); },
  exists: function(path) { return __call("fs", "exists", [path]); },
};
`);
  }

  parts.push(`
// === END HERMETIC BINDINGS ===
`);

  return parts.join("\n");
}
