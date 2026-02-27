// @hermetic/proc — HermeticProc class
//
// Process model using Web Workers. Each process gets its own Worker.
// stdin/stdout/stderr use TransformStreams for piping.

import { DisposableStore } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { HermeticProcInterface, ProcessHandle, ProcessRecord, SpawnOptions } from "./types.js";

let nextPid = 1;

export class HermeticProc implements HermeticProcInterface {
  private static readonly MAX_PROCESSES = 50;
  private static readonly MAX_CONCURRENT = 10;
  private processes = new Map<number, ProcessRecord>();
  private waiters = new Map<number, Array<(code: number) => void>>();
  private disposables = new DisposableStore();
  private fs?: HermeticFS;

  constructor(fs?: HermeticFS) {
    this.fs = fs;
  }

  spawn(command: string, args: string[] = [], options: SpawnOptions = {}): ProcessHandle {
    // Enforce process limits
    const running = [...this.processes.values()].filter((p) => p.status === "running").length;
    if (running >= HermeticProc.MAX_CONCURRENT) {
      throw new Error("Too many concurrent processes (max 10)");
    }
    if (this.processes.size >= HermeticProc.MAX_PROCESSES) {
      for (const [pid, proc] of this.processes) {
        if (proc.status !== "running") this.processes.delete(pid);
      }
      if (this.processes.size >= HermeticProc.MAX_PROCESSES) {
        throw new Error("Process table full (max 50)");
      }
    }

    const pid = nextPid++;

    const stdoutTransform = new TransformStream<Uint8Array>();
    const stderrTransform = new TransformStream<Uint8Array>();
    const stdinTransform = new TransformStream<Uint8Array>();

    const record: ProcessRecord = {
      pid,
      command,
      args,
      status: "running",
      worker: null,
    };
    this.processes.set(pid, record);

    const stdoutWriter = stdoutTransform.writable.getWriter();
    const stderrWriter = stderrTransform.writable.getWriter();

    // Execution timeout
    const timeout = options.timeout ?? 30_000;
    const killTimer = setTimeout(() => {
      if (record.status === "running") {
        this.kill(pid);
      }
    }, timeout);

    // For "node" — read the script from FS and execute it
    if (command === "node" && args.length > 0 && this.fs) {
      const scriptPath = args[0];
      this.fs.readFile(scriptPath, "utf-8").then((code: Uint8Array | string) => {
        const workerCode = this.generateNodeWorkerCode(code as string, args, options);
        this.startWorker(workerCode, pid, record, stdoutWriter, stderrWriter, killTimer);
      }).catch((err: Error) => {
        stderrWriter.write(new TextEncoder().encode(`Error: ${err.message}\n`)).catch(() => {});
        record.status = "exited";
        record.exitCode = 1;
        stderrWriter.close().catch(() => {});
        stdoutWriter.close().catch(() => {});
        clearTimeout(killTimer);
        this.notifyWaiters(pid, 1);
      });
    } else {
      const workerCode = this.generateGenericWorkerCode(command, args);
      this.startWorker(workerCode, pid, record, stdoutWriter, stderrWriter, killTimer);
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

  private startWorker(
    code: string,
    pid: number,
    record: ProcessRecord,
    stdoutWriter: WritableStreamDefaultWriter<Uint8Array>,
    stderrWriter: WritableStreamDefaultWriter<Uint8Array>,
    killTimer: ReturnType<typeof setTimeout>,
  ): void {
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    record.worker = worker;

    worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg?.type === "stdout") {
        const data = new TextEncoder().encode(String(msg.data));
        stdoutWriter.write(data).catch(() => {});
      } else if (msg?.type === "stderr") {
        const data = new TextEncoder().encode(String(msg.data));
        stderrWriter.write(data).catch(() => {});
      } else if (msg?.type === "exit") {
        const exitCode = (msg.code ?? 0) as number;
        record.status = "exited";
        record.exitCode = exitCode;
        record.worker = null;
        clearTimeout(killTimer);
        stdoutWriter.close().catch(() => {});
        stderrWriter.close().catch(() => {});
        this.notifyWaiters(pid, exitCode);
      }
    });

    worker.addEventListener("error", (e) => {
      const errMsg = e.message || "Worker error";
      stderrWriter.write(new TextEncoder().encode(errMsg + "\n")).catch(() => {});
      record.status = "exited";
      record.exitCode = 1;
      record.worker = null;
      clearTimeout(killTimer);
      stdoutWriter.close().catch(() => {});
      stderrWriter.close().catch(() => {});
      this.notifyWaiters(pid, 1);
    });
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

  private generateNodeWorkerCode(userCode: string, args: string[], options: SpawnOptions): string {
    const envJson = JSON.stringify(options.env ?? {});
    const argsJson = JSON.stringify(["node", ...args]);
    return `
// Hermetic Node.js emulation layer
const console = {
  log: (...args) => self.postMessage({ type: "stdout", data: args.join(" ") + "\\n" }),
  error: (...args) => self.postMessage({ type: "stderr", data: args.join(" ") + "\\n" }),
  warn: (...args) => self.postMessage({ type: "stderr", data: args.join(" ") + "\\n" }),
  info: (...args) => self.postMessage({ type: "stdout", data: args.join(" ") + "\\n" }),
};

const process = {
  env: ${envJson},
  argv: ${argsJson},
  exit: (code) => self.postMessage({ type: "exit", code: code ?? 0 }),
  stdout: { write: (s) => self.postMessage({ type: "stdout", data: String(s) }) },
  stderr: { write: (s) => self.postMessage({ type: "stderr", data: String(s) }) },
};

try {
  ${userCode}
  self.postMessage({ type: "exit", code: 0 });
} catch(e) {
  self.postMessage({ type: "stderr", data: e.stack || e.message || String(e) });
  self.postMessage({ type: "exit", code: 1 });
}
`;
  }

  private generateGenericWorkerCode(command: string, _args: string[]): string {
    return `
self.addEventListener("message", function(event) {
  if (event.data && event.data.type === "stdin") {
    // Handle stdin data
  }
});

try {
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

export function createProc(fs?: HermeticFS): HermeticProc {
  return new HermeticProc(fs);
}
