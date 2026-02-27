// @hermetic/proc — Public API

export type {
  ProcessRecord,
  SpawnOptions,
  ProcessHandle,
  HermeticProcInterface,
} from "./types.js";

export { HermeticProc, createProc } from "./proc.js";
