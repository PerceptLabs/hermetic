// @hermetic/shell — AST executor

import { normalizePath, joinPath } from "@hermetic/core";
import type { HermeticFS } from "@hermetic/fs";
import type { ShellNode, CommandNode, PipelineNode, ListNode, ShellOutput } from "./types.js";
import { builtins } from "./builtins.js";

export interface ExecContext {
  fs: HermeticFS;
  cwd: string;
  env: Record<string, string>;
  setCwd: (path: string) => void;
}

export async function execute(node: ShellNode, ctx: ExecContext): Promise<ShellOutput> {
  switch (node.type) {
    case "command":
      return executeCommand(node, ctx);
    case "pipeline":
      return executePipeline(node, ctx);
    case "list":
      return executeList(node, ctx);
    default:
      return { stdout: "", stderr: `Unknown node type\n`, exitCode: 1 };
  }
}

async function executeCommand(node: CommandNode, ctx: ExecContext): Promise<ShellOutput> {
  // Apply assignments
  for (const assignment of node.assignments) {
    ctx.env[assignment.name] = expandVariables(assignment.value, ctx.env);
  }

  if (!node.name) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  // Expand variables in args
  const name = expandVariables(node.name, ctx.env);
  const args = node.args.map((a) => expandVariables(a, ctx.env));

  // Check builtins first
  if (name in builtins) {
    const result = await builtins[name](args, ctx);
    return applyRedirects(result, node, ctx);
  }

  // Unknown command
  return {
    stdout: "",
    stderr: `${name}: command not found\n`,
    exitCode: 127,
  };
}

async function executePipeline(node: PipelineNode, ctx: ExecContext): Promise<ShellOutput> {
  let lastOutput: ShellOutput = { stdout: "", stderr: "", exitCode: 0 };

  for (let i = 0; i < node.commands.length; i++) {
    const cmd = node.commands[i];
    const result = await execute(cmd, ctx);

    if (i < node.commands.length - 1) {
      // Pipe stdout to next command's stdin (simplified: pass as first arg)
      // Real piping would use TransformStreams, but for builtins we pass text
      const nextCmd = node.commands[i + 1];
      if (nextCmd.type === "command" && result.stdout) {
        // For grep/sort-like commands, pipe data via stdin simulation
        // This is simplified — real implementation would use streams
      }
    }

    lastOutput = {
      stdout: lastOutput.stdout + result.stdout,
      stderr: lastOutput.stderr + result.stderr,
      exitCode: result.exitCode,
    };
  }

  return lastOutput;
}

async function executeList(node: ListNode, ctx: ExecContext): Promise<ShellOutput> {
  const leftResult = await execute(node.left, ctx);

  switch (node.operator) {
    case "&&":
      if (leftResult.exitCode === 0) {
        const rightResult = await execute(node.right, ctx);
        return {
          stdout: leftResult.stdout + rightResult.stdout,
          stderr: leftResult.stderr + rightResult.stderr,
          exitCode: rightResult.exitCode,
        };
      }
      return leftResult;

    case "||":
      if (leftResult.exitCode !== 0) {
        const rightResult = await execute(node.right, ctx);
        return {
          stdout: leftResult.stdout + rightResult.stdout,
          stderr: leftResult.stderr + rightResult.stderr,
          exitCode: rightResult.exitCode,
        };
      }
      return leftResult;

    case ";": {
      const rightResult = await execute(node.right, ctx);
      return {
        stdout: leftResult.stdout + rightResult.stdout,
        stderr: leftResult.stderr + rightResult.stderr,
        exitCode: rightResult.exitCode,
      };
    }
  }
}

function expandVariables(str: string, env: Record<string, string>): string {
  return str.replace(/\$\{([^}]+)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, braced, simple) => {
    const name = braced ?? simple;
    // Handle default value syntax: ${VAR:-default}
    if (name.includes(":-")) {
      const [varName, defaultVal] = name.split(":-");
      return env[varName] ?? defaultVal ?? "";
    }
    return env[name] ?? "";
  });
}

async function applyRedirects(
  result: ShellOutput,
  node: CommandNode,
  ctx: ExecContext,
): Promise<ShellOutput> {
  for (const redirect of node.redirects) {
    const target = redirect.target.startsWith("/")
      ? normalizePath(redirect.target)
      : normalizePath(joinPath(ctx.cwd, redirect.target));

    switch (redirect.operator) {
      case ">":
        await ctx.fs.writeFile(target, result.stdout);
        return { ...result, stdout: "" };
      case ">>": {
        let existing = "";
        try {
          existing = (await ctx.fs.readFile(target, "utf-8")) as string;
        } catch {}
        await ctx.fs.writeFile(target, existing + result.stdout);
        return { ...result, stdout: "" };
      }
      case "2>&1":
        return { ...result, stdout: result.stdout + result.stderr, stderr: "" };
    }
  }
  return result;
}
