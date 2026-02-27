// @hermetic/shell — Built-in commands

import { normalizePath, joinPath, dirname, basename } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { ShellOutput } from "./types.js";

type BuiltinFn = (
  args: string[],
  ctx: { fs: HermeticFS; cwd: string; env: Record<string, string>; setCwd: (p: string) => void },
) => Promise<ShellOutput>;

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
    if (args.length === 0) {
      return { stdout: "", stderr: "cat: missing operand\n", exitCode: 1 };
    }
    let output = "";
    for (const file of args) {
      const resolved = file.startsWith("/") ? normalizePath(file) : normalizePath(joinPath(ctx.cwd, file));
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
    const known = ["node", "npm", "npx", "git", "ls", "cat", "echo", "mkdir", "rm", "cp", "mv", "touch", "pwd", "cd", "env", "export", "which", "clear", "exit", "grep", "find"];
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
};
