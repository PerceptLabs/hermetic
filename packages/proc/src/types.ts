// @hermetic/proc — Type definitions

import type { Disposable } from "@hermetic/core";

export interface ProcessRecord {
  pid: number;
  command: string;
  args: string[];
  status: "running" | "exited" | "killed";
  exitCode?: number;
  worker: Worker | null;
}

export interface SpawnOptions {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Stdin data or stream */
  stdin?: ReadableStream<Uint8Array> | Uint8Array | string;
}

export interface ProcessHandle extends Disposable {
  pid: number;
  /** Standard output stream */
  stdout: ReadableStream<Uint8Array>;
  /** Standard error stream */
  stderr: ReadableStream<Uint8Array>;
  /** Standard input writer */
  stdin: WritableStream<Uint8Array>;
  /** Wait for process to exit */
  wait(): Promise<number>;
  /** Send a signal to the process */
  kill(): void;
}

export interface HermeticProcInterface extends Disposable {
  /** Spawn a new process */
  spawn(command: string, args?: string[], options?: SpawnOptions): ProcessHandle;
  /** Wait for a process by PID */
  waitpid(pid: number): Promise<number>;
  /** Kill a process by PID */
  kill(pid: number): void;
  /** List running processes */
  list(): ProcessRecord[];
}
