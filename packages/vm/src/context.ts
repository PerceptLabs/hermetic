// @hermetic/vm — ExecutionContext
//
// Manages a single Worker for isolated code execution.
// Worker is created from a Blob URL with capability bindings prepended.

import { HermeticChannel, serializeError } from "@hermetic/core";
import type { ExecutionContext, EvalOptions, EvalResult, ConsoleEntry, CapabilityFlags } from "./types.js";
import { generateBindings } from "./bindings.js";

export class WorkerContext implements ExecutionContext {
  private worker: Worker | null;
  private port: MessagePort;
  private channel: HermeticChannel;
  private consoleCallbacks = new Set<(entry: ConsoleEntry) => void>();
  private logs: ConsoleEntry[] = [];

  constructor(
    code: string,
    capabilities: CapabilityFlags,
    capabilityHandlers?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>,
  ) {
    const bindingCode = generateBindings(capabilities);
    const fullCode = bindingCode + "\n" + code;

    // Create worker from Blob URL
    const blob = new Blob([fullCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    this.worker = new Worker(url);
    URL.revokeObjectURL(url);

    // Set up MessageChannel for capability routing
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.channel = new HermeticChannel(port1);

    // Register capability handlers on the host side
    if (capabilityHandlers) {
      for (const [ns, methods] of Object.entries(capabilityHandlers)) {
        this.channel.handle(ns, methods);
      }
    }

    // Listen for console events and other notifications from worker
    port1.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg?.__hermetic || msg.ns !== "vm" || msg.event !== "console") return;
      const entry: ConsoleEntry = { level: msg.level, args: msg.args };
      this.logs.push(entry);
      this.consoleCallbacks.forEach((cb) => cb(entry));
    });

    // Transfer port2 to the worker
    this.worker.postMessage({ type: "hermetic-vm-init" }, [port2]);
  }

  async eval(code: string, options?: EvalOptions): Promise<EvalResult> {
    if (!this.worker) throw new Error("Context terminated");

    // For eval, we send code to execute via a message and get result back
    const id = crypto.randomUUID();
    const timeout = options?.timeout ?? 30_000;

    return new Promise<EvalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Execution timeout"));
        this.terminate();
      }, timeout);

      const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg?.__hermetic || msg.id !== id) return;
        this.worker?.removeEventListener("message", handler);
        clearTimeout(timer);
        if (msg.ok) {
          resolve({ value: msg.value, logs: [...this.logs] });
        } else {
          reject(new Error(msg.error?.message ?? "Execution failed"));
        }
      };

      this.worker!.addEventListener("message", handler);
      this.worker!.postMessage({
        __hermetic: true,
        ns: "vm",
        id,
        type: "eval",
        code,
      });
    });
  }

  onConsole(callback: (entry: ConsoleEntry) => void): () => void {
    this.consoleCallbacks.add(callback);
    return () => this.consoleCallbacks.delete(callback);
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.channel.dispose();
  }

  dispose(): void {
    this.terminate();
    this.consoleCallbacks.clear();
    this.logs = [];
  }
}
