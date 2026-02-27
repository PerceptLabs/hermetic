// @hermetic/shell — Recursive descent shell parser
//
// Grammar:
// ShellLine     → Pipeline (("&&" | "||" | ";") Pipeline)*
// Pipeline      → Command ("|" Command)*
// Command       → SimpleCommand
// SimpleCommand → Word+

import type { ShellNode, CommandNode, PipelineNode, ListNode, RedirectNode, AssignmentNode } from "./types.js";

interface Token {
  type: "word" | "pipe" | "and" | "or" | "semi" | "redirect" | "eof";
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (input[i] === " " || input[i] === "\t") {
      i++;
      continue;
    }

    // Operators
    if (input[i] === "|" && input[i + 1] === "|") {
      tokens.push({ type: "or", value: "||" });
      i += 2;
      continue;
    }
    if (input[i] === "&" && input[i + 1] === "&") {
      tokens.push({ type: "and", value: "&&" });
      i += 2;
      continue;
    }
    if (input[i] === "|") {
      tokens.push({ type: "pipe", value: "|" });
      i++;
      continue;
    }
    if (input[i] === ";") {
      tokens.push({ type: "semi", value: ";" });
      i++;
      continue;
    }
    if (input[i] === ">" && input[i + 1] === ">") {
      tokens.push({ type: "redirect", value: ">>" });
      i += 2;
      continue;
    }
    if (input[i] === ">") {
      tokens.push({ type: "redirect", value: ">" });
      i++;
      continue;
    }
    if (input[i] === "<") {
      tokens.push({ type: "redirect", value: "<" });
      i++;
      continue;
    }

    // Quoted strings
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      let word = "";
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && quote === '"') {
          i++;
          if (i < input.length) word += input[i];
        } else {
          word += input[i];
        }
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: "word", value: word });
      continue;
    }

    // Regular words
    let word = "";
    while (i < input.length && !" \t|&;><\"'".includes(input[i])) {
      word += input[i];
      i++;
    }
    if (word) {
      tokens.push({ type: "word", value: word });
    }
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "eof", value: "" };
  }

  private next(): Token {
    return this.tokens[this.pos++] ?? { type: "eof", value: "" };
  }

  parseShellLine(): ShellNode | null {
    let left = this.parsePipeline();
    if (!left) return null;

    while (this.peek().type === "and" || this.peek().type === "or" || this.peek().type === "semi") {
      const op = this.next();
      const right = this.parsePipeline();
      if (!right) break;
      left = {
        type: "list",
        operator: op.value as "&&" | "||" | ";",
        left,
        right,
      } satisfies ListNode;
    }

    return left;
  }

  parsePipeline(): ShellNode | null {
    const first = this.parseCommand();
    if (!first) return null;

    const commands: ShellNode[] = [first];
    while (this.peek().type === "pipe") {
      this.next(); // consume '|'
      const cmd = this.parseCommand();
      if (cmd) commands.push(cmd);
    }

    if (commands.length === 1) return commands[0];
    return { type: "pipeline", commands } satisfies PipelineNode;
  }

  parseCommand(): ShellNode | null {
    const assignments: AssignmentNode[] = [];
    const redirects: RedirectNode[] = [];
    const words: string[] = [];

    while (this.peek().type === "word" || this.peek().type === "redirect") {
      if (this.peek().type === "redirect") {
        const op = this.next();
        const target = this.peek().type === "word" ? this.next().value : "";
        redirects.push({ type: "redirect", operator: op.value as RedirectNode["operator"], target });
        continue;
      }

      const word = this.next().value;

      // Check for assignment (NAME=VALUE at start)
      if (words.length === 0 && word.includes("=") && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word)) {
        const eqIdx = word.indexOf("=");
        assignments.push({
          type: "assignment",
          name: word.slice(0, eqIdx),
          value: word.slice(eqIdx + 1),
        });
        continue;
      }

      words.push(word);
    }

    if (words.length === 0 && assignments.length === 0) return null;

    return {
      type: "command",
      name: words[0] ?? "",
      args: words.slice(1),
      redirects,
      assignments,
    } satisfies CommandNode;
  }
}

export function parse(input: string): ShellNode | null {
  const tokens = tokenize(input.trim());
  const parser = new Parser(tokens);
  return parser.parseShellLine();
}
