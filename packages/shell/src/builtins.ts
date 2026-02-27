// @hermetic/shell — Built-in commands

import { normalizePath, joinPath, dirname, basename } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { ShellOutput } from "./types.js";

type BuiltinFn = (
  args: string[],
  ctx: { fs: HermeticFS; cwd: string; env: Record<string, string>; setCwd: (p: string) => void; stdin?: string },
) => Promise<ShellOutput>;

function resolvePath(cwd: string, p: string): string {
  return p.startsWith("/") ? normalizePath(p) : normalizePath(joinPath(cwd, p));
}

export const builtins: Record<string, BuiltinFn> = {
  echo: async (args) => ({
    stdout: args.join(" ") + "\n",
    stderr: "",
    exitCode: 0,
  }),

  pwd: async (_args, ctx) => ({
    stdout: ctx.cwd + "\n",
    stderr: "",
    exitCode: 0,
  }),

  cd: async (args, ctx) => {
    const target = args[0] ?? "/";
    const resolved = target.startsWith("/") ? normalizePath(target) : normalizePath(joinPath(ctx.cwd, target));
    try {
      const stat = await ctx.fs.stat(resolved);
      if (stat.type !== "directory") {
        return { stdout: "", stderr: `cd: not a directory: ${target}\n`, exitCode: 1 };
      }
      ctx.setCwd(resolved);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch {
      return { stdout: "", stderr: `cd: no such file or directory: ${target}\n`, exitCode: 1 };
    }
  },

  ls: async (args, ctx) => {
    const target = args[0] ?? ctx.cwd;
    const resolved = target.startsWith("/") ? normalizePath(target) : normalizePath(joinPath(ctx.cwd, target));
    try {
      const entries = await ctx.fs.readdir(resolved);
      return { stdout: entries.join("\n") + (entries.length ? "\n" : ""), stderr: "", exitCode: 0 };
    } catch {
      return { stdout: "", stderr: `ls: cannot access '${target}': No such file or directory\n`, exitCode: 1 };
    }
  },

  cat: async (args, ctx) => {
    // If no args but stdin available, pass through stdin
    if (args.length === 0) {
      if (ctx.stdin) return { stdout: ctx.stdin, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "cat: missing operand\n", exitCode: 1 };
    }
    let output = "";
    for (const file of args) {
      const resolved = resolvePath(ctx.cwd, file);
      try {
        const content = await ctx.fs.readFile(resolved, "utf-8");
        output += content as string;
      } catch {
        return { stdout: output, stderr: `cat: ${file}: No such file or directory\n`, exitCode: 1 };
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  },

  mkdir: async (args, ctx) => {
    const recursive = args.includes("-p");
    const paths = args.filter((a) => a !== "-p");
    for (const path of paths) {
      const resolved = path.startsWith("/") ? normalizePath(path) : normalizePath(joinPath(ctx.cwd, path));
      try {
        await ctx.fs.mkdir(resolved, { recursive });
      } catch (e: any) {
        return { stdout: "", stderr: `mkdir: ${e.message}\n`, exitCode: 1 };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  },

  rm: async (args, ctx) => {
    const recursive = args.includes("-r") || args.includes("-rf") || args.includes("-fr");
    const force = args.includes("-f") || args.includes("-rf") || args.includes("-fr");
    const paths = args.filter((a) => !a.startsWith("-"));
    for (const path of paths) {
      const resolved = path.startsWith("/") ? normalizePath(path) : normalizePath(joinPath(ctx.cwd, path));
      try {
        const stat = await ctx.fs.stat(resolved);
        if (stat.type === "directory") {
          await ctx.fs.rmdir(resolved, { recursive });
        } else {
          await ctx.fs.unlink(resolved);
        }
      } catch (e: any) {
        if (!force) {
          return { stdout: "", stderr: `rm: ${e.message}\n`, exitCode: 1 };
        }
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  },

  cp: async (args, ctx) => {
    if (args.length < 2) {
      return { stdout: "", stderr: "cp: missing operand\n", exitCode: 1 };
    }
    const src = args[0].startsWith("/") ? normalizePath(args[0]) : normalizePath(joinPath(ctx.cwd, args[0]));
    const dest = args[1].startsWith("/") ? normalizePath(args[1]) : normalizePath(joinPath(ctx.cwd, args[1]));
    try {
      await ctx.fs.copyFile(src, dest);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: any) {
      return { stdout: "", stderr: `cp: ${e.message}\n`, exitCode: 1 };
    }
  },

  mv: async (args, ctx) => {
    if (args.length < 2) {
      return { stdout: "", stderr: "mv: missing operand\n", exitCode: 1 };
    }
    const src = args[0].startsWith("/") ? normalizePath(args[0]) : normalizePath(joinPath(ctx.cwd, args[0]));
    const dest = args[1].startsWith("/") ? normalizePath(args[1]) : normalizePath(joinPath(ctx.cwd, args[1]));
    try {
      await ctx.fs.rename(src, dest);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: any) {
      return { stdout: "", stderr: `mv: ${e.message}\n`, exitCode: 1 };
    }
  },

  touch: async (args, ctx) => {
    for (const file of args) {
      const resolved = file.startsWith("/") ? normalizePath(file) : normalizePath(joinPath(ctx.cwd, file));
      if (await ctx.fs.exists(resolved)) {
        await ctx.fs.utimes(resolved, new Date(), new Date());
      } else {
        await ctx.fs.writeFile(resolved, "");
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  },

  env: async (_args, ctx) => {
    const output = Object.entries(ctx.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    return { stdout: output + "\n", stderr: "", exitCode: 0 };
  },

  export: async (args, ctx) => {
    for (const arg of args) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > 0) {
        ctx.env[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  },

  which: async (args) => {
    const known = ["node", "npm", "npx", "git", "ls", "cat", "echo", "mkdir", "rm", "cp", "mv", "touch", "pwd", "cd", "env", "export", "which", "clear", "exit", "grep", "sort", "head", "tail", "wc", "uniq", "find"];
    const name = args[0];
    if (name && known.includes(name)) {
      return { stdout: `/usr/bin/${name}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `which: ${name}: not found\n`, exitCode: 1 };
  },

  clear: async () => ({
    stdout: "\x1b[2J\x1b[H",
    stderr: "",
    exitCode: 0,
  }),

  exit: async (args) => ({
    stdout: "",
    stderr: "",
    exitCode: parseInt(args[0] ?? "0", 10),
  }),

  grep: async (args, ctx) => {
    const pattern = args[0];
    if (!pattern) return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 2 };

    let input: string;
    if (args.length > 1) {
      const path = resolvePath(ctx.cwd, args[1]);
      input = (await ctx.fs.readFile(path, "utf-8")) as string;
    } else if (ctx.stdin) {
      input = ctx.stdin;
    } else {
      return { stdout: "", stderr: "grep: no input\n", exitCode: 2 };
    }

    const regex = new RegExp(pattern);
    const matches = input.split("\n").filter((line) => regex.test(line));
    return {
      stdout: matches.join("\n") + (matches.length ? "\n" : ""),
      stderr: "",
      exitCode: matches.length ? 0 : 1,
    };
  },

  sort: async (args, ctx) => {
    const reverse = args.includes("-r");
    const fileArgs = args.filter((a) => !a.startsWith("-"));
    const input = fileArgs[0]
      ? ((await ctx.fs.readFile(resolvePath(ctx.cwd, fileArgs[0]), "utf-8")) as string)
      : ctx.stdin ?? "";
    const lines = input.split("\n").filter(Boolean);
    lines.sort();
    if (reverse) lines.reverse();
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  },

  head: async (args, ctx) => {
    let n = 10;
    const fileArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-n" && i + 1 < args.length) {
        n = parseInt(args[++i]) || 10;
      } else if (args[i].startsWith("-n")) {
        n = parseInt(args[i].slice(2)) || 10;
      } else if (!args[i].startsWith("-")) {
        fileArgs.push(args[i]);
      }
    }
    const input = fileArgs[0]
      ? ((await ctx.fs.readFile(resolvePath(ctx.cwd, fileArgs[0]), "utf-8")) as string)
      : ctx.stdin ?? "";
    const lines = input.split("\n");
    const result = lines.slice(0, n);
    return { stdout: result.join("\n") + "\n", stderr: "", exitCode: 0 };
  },

  tail: async (args, ctx) => {
    let n = 10;
    const fileArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-n" && i + 1 < args.length) {
        n = parseInt(args[++i]) || 10;
      } else if (args[i].startsWith("-n")) {
        n = parseInt(args[i].slice(2)) || 10;
      } else if (!args[i].startsWith("-")) {
        fileArgs.push(args[i]);
      }
    }
    const input = fileArgs[0]
      ? ((await ctx.fs.readFile(resolvePath(ctx.cwd, fileArgs[0]), "utf-8")) as string)
      : ctx.stdin ?? "";
    const lines = input.split("\n").filter(Boolean);
    const result = lines.slice(-n);
    return { stdout: result.join("\n") + "\n", stderr: "", exitCode: 0 };
  },

  wc: async (args, ctx) => {
    const fileArgs = args.filter((a) => !a.startsWith("-"));
    const input = fileArgs[0]
      ? ((await ctx.fs.readFile(resolvePath(ctx.cwd, fileArgs[0]), "utf-8")) as string)
      : ctx.stdin ?? "";
    const lines = input.split("\n").length - (input.endsWith("\n") ? 1 : 0);
    const words = input.split(/\s+/).filter(Boolean).length;
    const chars = input.length;
    return { stdout: `  ${lines}  ${words}  ${chars}\n`, stderr: "", exitCode: 0 };
  },

  uniq: async (args, ctx) => {
    const fileArgs = args.filter((a) => !a.startsWith("-"));
    const input = fileArgs[0]
      ? ((await ctx.fs.readFile(resolvePath(ctx.cwd, fileArgs[0]), "utf-8")) as string)
      : ctx.stdin ?? "";
    const lines = input.split("\n");
    const result: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 || lines[i] !== lines[i - 1]) {
        result.push(lines[i]);
      }
    }
    return { stdout: result.join("\n"), stderr: "", exitCode: 0 };
  },
};
