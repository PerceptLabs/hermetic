// @hermetic/vm — Public API

export type {
  ContextOptions,
  CapabilityFlags,
  EvalOptions,
  EvalResult,
  ConsoleEntry,
  ExecutionContext,
  HermeticVMInterface,
} from "./types.js";

export { HermeticVM, createVM } from "./vm.js";
export { WorkerContext } from "./context.js";
export { generateBindings } from "./bindings.js";
