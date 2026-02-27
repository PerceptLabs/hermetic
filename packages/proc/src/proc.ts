// @hermetic/proc — HermeticProc class
//
// Process model using Web Workers. Each process gets its own Worker.
// stdin/stdout/stderr use TransformStreams for piping.

import { DisposableStore } from "@hermetic/core";
import type { HermeticProcInterface, ProcessHandle, ProcessRecord, SpawnOptions } from "./types.js";

let nextPid = 1;

export class HermeticProc implements HermeticProcInterface {
  private processes = new Map<number, ProcessRecord>();
  private waiters = new Map<number, Array<(code: number) => void>>();
  private disposables = new DisposableStore();

  spawn(command: string, args: string[] = [], options: SpawnOptions = {}): ProcessHandle {
    const pid = nextPid++;

    // Create stdout/stderr TransformStreams
    const stdoutTransform = new TransformStream<Uint8Array>();
    const stderrTransform = new TransformStream<Uint8Array>();
    const stdinTransform = new TransformStream<Uint8Array>();

    // Create the worker with a simple script
    const workerCode = this.generateWorkerCode(command, args, options);
    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);

    const record: ProcessRecord = {
      pid,
      command,
      args,
      status: "running",
      worker,
    };
    this.processes.set(pid, record);

    const stdoutWriter = stdoutTransform.writable.getWriter();
    const stderrWriter = stderrTransform.writable.getWriter();

    // Handle worker messages
    worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg?.type === "stdout" && msg.data) {
        const data = typeof msg.data === "string"
          ? new TextEncoder().encode(msg.data)
          : new Uint8Array(msg.data);
        stdoutWriter.write(data).catch(() => {});
      } else if (msg?.type === "stderr" && msg.data) {
        const data = typeof msg.data === "string"
          ? new TextEncoder().encode(msg.data)
          : new Uint8Array(msg.data);
        stderrWriter.write(data).catch(() => {});
      } else if (msg?.type === "exit") {
        const exitCode = (msg.code ?? 0) as number;
        record.status = "exited";
        record.exitCode = exitCode;
        record.worker = null;
        stdoutWriter.close().catch(() => {});
        stderrWriter.close().catch(() => {});
        this.notifyWaiters(pid, exitCode);
      }
    });

    worker.addEventListener("error", () => {
      record.status = "exited";
      record.exitCode = 1;
      record.worker = null;
      stdoutWriter.close().catch(() => {});
      stderrWriter.close().catch(() => {});
      this.notifyWaiters(pid, 1);
    });

    // Provide stdin data if given
    if (options.stdin) {
      if (typeof options.stdin === "string") {
        worker.postMessage({ type: "stdin", data: options.stdin });
      } else if (options.stdin instanceof Uint8Array) {
        worker.postMessage({ type: "stdin", data: options.stdin.buffer }, [options.stdin.buffer]);
      }
    }

    const handle: ProcessHandle = {
      pid,
      stdout: stdoutTransform.readable,
      stderr: stderrTransform.readable,
      stdin: stdinTransform.writable,
      wait: () => this.waitpid(pid),
      kill: () => this.kill(pid),
      dispose: () => this.kill(pid),
    };

    return handle;
  }

  async waitpid(pid: number): Promise<number> {
    const record = this.processes.get(pid);
    if (!record) throw new Error(`No such process: ${pid}`);
    if (record.status === "exited" || record.status === "killed") {
      return record.exitCode ?? 0;
    }

    return new Promise<number>((resolve) => {
      if (!this.waiters.has(pid)) this.waiters.set(pid, []);
      this.waiters.get(pid)!.push(resolve);
    });
  }

  kill(pid: number): void {
    const record = this.processes.get(pid);
    if (!record || !record.worker) return;
    record.worker.terminate();
    record.status = "killed";
    record.exitCode = 137;
    record.worker = null;
    this.notifyWaiters(pid, 137);
  }

  list(): ProcessRecord[] {
    return Array.from(this.processes.values());
  }

  private notifyWaiters(pid: number, code: number): void {
    const waiters = this.waiters.get(pid);
    if (waiters) {
      for (const resolve of waiters) resolve(code);
      this.waiters.delete(pid);
    }
  }

  private generateWorkerCode(command: string, args: string[], options: SpawnOptions): string {
    // The worker code evaluates the command and reports stdout/exit
    return `
self.addEventListener("message", function(event) {
  if (event.data && event.data.type === "stdin") {
    // Handle stdin data
  }
});

try {
  // For now, just report that the process started and exited
  self.postMessage({ type: "stdout", data: "" });
  self.postMessage({ type: "exit", code: 0 });
} catch(e) {
  self.postMessage({ type: "stderr", data: e.message || String(e) });
  self.postMessage({ type: "exit", code: 1 });
}
`;
  }

  dispose(): void {
    for (const [pid] of this.processes) {
      this.kill(pid);
    }
    this.processes.clear();
    this.waiters.clear();
    this.disposables.dispose();
  }
}

export function createProc(): HermeticProc {
  return new HermeticProc();
}
