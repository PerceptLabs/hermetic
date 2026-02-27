// @hermetic/runtime — Hermetic facade class
//
// Wires all subsystems together into a single runtime instance.

import { DisposableStore } from "@hermetic/core";
import { createFS, type HermeticFS, type FSOptions } from "@hermetic/fs";
import { createVM, type HermeticVM } from "@hermetic/vm";
import { createPM, type HermeticPM } from "@hermetic/pm";
import { createProc, type HermeticProc } from "@hermetic/proc";
import { createShell, type HermeticShell } from "@hermetic/shell";

export interface HermeticOptions {
  /** Filesystem backend */
  fs?: FSOptions;
  /** Initial environment variables */
  env?: Record<string, string>;
  /** Initial working directory */
  cwd?: string;
}

export class Hermetic {
  readonly fs: HermeticFS;
  readonly vm: HermeticVM;
  readonly pm: HermeticPM;
  readonly proc: HermeticProc;
  readonly shell: HermeticShell;
  private disposables = new DisposableStore();

  private constructor(
    fs: HermeticFS,
    vm: HermeticVM,
    pm: HermeticPM,
    proc: HermeticProc,
    shell: HermeticShell,
  ) {
    this.fs = fs;
    this.vm = vm;
    this.pm = pm;
    this.proc = proc;
    this.shell = shell;

    // Register all for cleanup
    this.disposables.add(shell);
    this.disposables.add(proc);
    this.disposables.add(pm);
    this.disposables.add(vm);
    this.disposables.add(fs);
  }

  static async create(options: HermeticOptions = {}): Promise<Hermetic> {
    const fs = await createFS(options.fs);
    const vm = createVM();
    const pm = createPM({ fs });
    const proc = createProc(fs);
    const shell = createShell(fs, { cwd: options.cwd, env: options.env });

    return new Hermetic(fs, vm, pm, proc, shell);
  }

  dispose(): void {
    this.disposables.dispose();
  }
}
