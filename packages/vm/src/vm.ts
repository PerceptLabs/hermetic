// @hermetic/vm — HermeticVM class
//
// Main VM interface for creating isolated execution contexts.

import { DisposableStore } from "@hermetic/core";
import type { HermeticVMInterface, ContextOptions, EvalOptions, EvalResult, ExecutionContext } from "./types.js";
import { WorkerContext } from "./context.js";

export class HermeticVM implements HermeticVMInterface {
  private disposables = new DisposableStore();
  private capabilityHandlers: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

  constructor(
    capabilityHandlers: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {},
  ) {
    this.capabilityHandlers = capabilityHandlers;
  }

  createContext(options: ContextOptions = {}): ExecutionContext {
    const capabilities = options.capabilities ?? { console: true, fetch: true };

    // Create a worker context with an eval loop
    const evalLoopCode = `
// Eval loop — listens for eval requests from host
self.addEventListener("message", async function(event) {
  const msg = event.data;
  if (!msg || !msg.__hermetic || msg.ns !== "vm" || msg.type !== "eval") return;
  try {
    const __result = await eval(msg.code);
    self.postMessage({ __hermetic: true, id: msg.id, ok: true, value: __result });
  } catch (err) {
    self.postMessage({
      __hermetic: true,
      id: msg.id,
      ok: false,
      error: { name: err.name, message: err.message },
    });
  }
});
`;

    const ctx = new WorkerContext(evalLoopCode, capabilities, this.capabilityHandlers);
    this.disposables.add(ctx);
    return ctx;
  }

  async eval(code: string, options: ContextOptions & EvalOptions = {}): Promise<EvalResult> {
    const ctx = this.createContext(options);
    try {
      return await ctx.eval(code, { timeout: options.timeout });
    } finally {
      ctx.dispose();
    }
  }

  dispose(): void {
    this.disposables.dispose();
  }
}

export function createVM(
  capabilityHandlers?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>,
): HermeticVM {
  return new HermeticVM(capabilityHandlers);
}
