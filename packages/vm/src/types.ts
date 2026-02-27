// @hermetic/vm — Type definitions

import type { Disposable } from "@hermetic/core";

export interface ContextOptions {
  /** Capabilities to expose to user code */
  capabilities?: CapabilityFlags;
  /** Environment variables to expose */
  env?: Record<string, string>;
  /** Timeout for execution in milliseconds (default: 30000) */
  timeout?: number;
}

export interface CapabilityFlags {
  /** Enable fetch capability */
  fetch?: boolean;
  /** Enable console capture */
  console?: boolean;
  /** Enable fs capability */
  fs?: boolean;
}

export interface EvalOptions {
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface EvalResult {
  /** The return value (structured-clone-safe) */
  value: unknown;
  /** Captured console output */
  logs: ConsoleEntry[];
}

export interface ConsoleEntry {
  level: "log" | "error" | "warn" | "info";
  args: string[];
}

export interface ExecutionContext extends Disposable {
  /** Evaluate code in this context */
  eval(code: string, options?: EvalOptions): Promise<EvalResult>;
  /** Listen for console events */
  onConsole(callback: (entry: ConsoleEntry) => void): () => void;
  /** Terminate the execution context */
  terminate(): void;
}

export interface HermeticVMInterface extends Disposable {
  /** Create a new isolated execution context */
  createContext(options?: ContextOptions): ExecutionContext;
  /** Evaluate code in a temporary context (create, run, dispose) */
  eval(code: string, options?: ContextOptions & EvalOptions): Promise<EvalResult>;
}
