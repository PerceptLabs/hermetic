// @hermetic/shell — HermeticShell class

import type { HermeticFS } from "@hermetic/fs";
import type { HermeticShellInterface, ShellOptions, ShellOutput } from "./types.js";
import { parse } from "./parser.js";
import { execute, type ExecContext } from "./executor.js";

export class HermeticShell implements HermeticShellInterface {
  private _cwd: string;
  private _env: Record<string, string>;
  private fs: HermeticFS;
  private history: string[] = [];

  constructor(fs: HermeticFS, options: ShellOptions = {}) {
    this.fs = fs;
    this._cwd = options.cwd ?? "/";
    this._env = {
      HOME: "/home",
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/sh",
      USER: "hermetic",
      ...options.env,
    };
  }

  async exec(command: string): Promise<ShellOutput> {
    this.history.push(command);

    const ast = parse(command);
    if (!ast) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    const ctx: ExecContext = {
      fs: this.fs,
      cwd: this._cwd,
      env: this._env,
      setCwd: (path: string) => {
        this._cwd = path;
      },
    };

    return execute(ast, ctx);
  }

  cwd(): string {
    return this._cwd;
  }

  cd(path: string): void {
    this._cwd = path;
  }

  env(): Record<string, string> {
    return { ...this._env };
  }

  dispose(): void {
    this.history = [];
  }
}

export function createShell(fs: HermeticFS, options?: ShellOptions): HermeticShell {
  return new HermeticShell(fs, options);
}
