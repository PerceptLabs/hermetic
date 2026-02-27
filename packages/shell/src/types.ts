// @hermetic/shell — Type definitions

import type { Disposable } from "@hermetic/core";

// === AST Types ===

export type ShellNode =
  | CommandNode
  | PipelineNode
  | ListNode
  | SubshellNode;

export interface CommandNode {
  type: "command";
  name: string;
  args: string[];
  redirects: RedirectNode[];
  assignments: AssignmentNode[];
}

export interface PipelineNode {
  type: "pipeline";
  commands: ShellNode[];
}

export interface ListNode {
  type: "list";
  operator: "&&" | "||" | ";";
  left: ShellNode;
  right: ShellNode;
}

export interface SubshellNode {
  type: "subshell";
  body: ShellNode;
}

export interface RedirectNode {
  type: "redirect";
  operator: ">" | ">>" | "<" | "2>&1";
  target: string;
}

export interface AssignmentNode {
  type: "assignment";
  name: string;
  value: string;
}

// === Shell interface ===

export interface ShellOptions {
  /** Initial working directory */
  cwd?: string;
  /** Initial environment variables */
  env?: Record<string, string>;
}

export interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HermeticShellInterface extends Disposable {
  /** Execute a command string */
  exec(command: string): Promise<ShellOutput>;
  /** Get current working directory */
  cwd(): string;
  /** Set current working directory */
  cd(path: string): void;
  /** Get environment variables */
  env(): Record<string, string>;
}
