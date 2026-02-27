// @hermetic/core — RPC-over-MessageChannel abstraction
//
// Usage (host side):
//   const channel = new HermeticChannel(port);
//   channel.handle("fs", {
//     readFile: async (path: string) => { ... },
//     writeFile: async (path: string, data: ArrayBuffer) => { ... },
//   });
//
// Usage (sandbox side):
//   const channel = new HermeticChannel(port);
//   const data = await channel.call("fs", "readFile", ["/app.ts"]);

import type {
  RequestMessage,
  ResponseMessage,
  NotificationMessage,
  HermeticMessage,
} from "./protocol.js";
import { serializeError, deserializeError, isHermeticMessage } from "./protocol.js";
import type { Disposable } from "./types.js";

export class HermeticChannel implements Disposable {
  private port: MessagePort;
  private pending: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
  private handlers: Map<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
  private listeners: Map<string, Set<(data: unknown) => void>>;
  private disposed: boolean;

  constructor(port: MessagePort, private defaultTimeout = 30_000) {
    this.port = port;
    this.pending = new Map();
    this.handlers = new Map();
    this.listeners = new Map();
    this.disposed = false;
    this.port.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
  }

  // --- Caller side: make a request, get a response ---

  async call(
    ns: string,
    method: string,
    args: unknown[],
    transfer?: Transferable[],
  ): Promise<unknown> {
    if (this.disposed) throw new Error("Channel disposed");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermetic RPC timeout: ${ns}.${method} (${this.defaultTimeout}ms)`));
      }, this.defaultTimeout);
      this.pending.set(id, { resolve, reject, timeout });

      const msg: RequestMessage = {
        __hermetic: true,
        ns,
        id,
        method,
        args,
      };
      const transferList: Transferable[] = transfer ?? [];
      this.port.postMessage(msg, transferList);
    });
  }

  // --- Handler side: register methods that respond to requests ---

  handle(ns: string, methods: Record<string, (...args: unknown[]) => Promise<unknown>>): void {
    this.handlers.set(ns, methods);
  }

  // --- Event listening for notifications ---

  on(event: string, callback: (data: unknown) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  notify(ns: string, event: string, data: unknown): void {
    if (this.disposed) return;
    const msg: NotificationMessage = { __hermetic: true, ns, event, data };
    this.port.postMessage(msg);
  }

  // --- Internal message routing ---

  private async handleMessage(msg: unknown): Promise<void> {
    if (!isHermeticMessage(msg)) return;
    const m = msg as HermeticMessage;

    // Response to our request
    if ("ok" in m && "id" in m && !("method" in m)) {
      const resp = m as ResponseMessage;
      const handler = this.pending.get(resp.id);
      if (!handler) return;
      this.pending.delete(resp.id);
      clearTimeout(handler.timeout);
      if (resp.ok) {
        handler.resolve(resp.value);
      } else {
        handler.reject(deserializeError(resp.error));
      }
      return;
    }

    // Request for us to handle
    if ("method" in m && "id" in m && !("ok" in m) && !("stream" in m) && !("event" in m)) {
      const req = m as RequestMessage;
      const handler = this.handlers.get(req.ns);
      if (!handler || !handler[req.method]) {
        const errResp: ResponseMessage = {
          __hermetic: true,
          ns: req.ns,
          id: req.id,
          ok: false,
          error: { name: "Error", message: `Unknown method: ${req.ns}.${req.method}` },
        };
        this.port.postMessage(errResp);
        return;
      }
      try {
        const value = await handler[req.method](...req.args);
        const transfer: Transferable[] = [];
        if (value instanceof ArrayBuffer) transfer.push(value);
        const okResp: ResponseMessage = {
          __hermetic: true,
          ns: req.ns,
          id: req.id,
          ok: true,
          value,
        };
        this.port.postMessage(okResp, transfer);
      } catch (err) {
        const errResp: ResponseMessage = {
          __hermetic: true,
          ns: req.ns,
          id: req.id,
          ok: false,
          error: serializeError(err),
        };
        this.port.postMessage(errResp);
      }
      return;
    }

    // Notification (no response expected)
    if ("event" in m && !("id" in m)) {
      const notif = m as NotificationMessage;
      const key = `${notif.ns}.${notif.event}`;
      this.listeners.get(key)?.forEach((cb) => cb(notif.data));
      return;
    }

    // Stream messages handled by streaming layer (future)
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
