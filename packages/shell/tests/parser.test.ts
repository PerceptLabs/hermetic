import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

describe("Shell Parser", () => {
  it("parses a simple command", () => {
    const ast = parse("echo hello world");
    expect(ast).toEqual({
      type: "command",
      name: "echo",
      args: ["hello", "world"],
      redirects: [],
      assignments: [],
    });
  });

  it("parses a pipeline", () => {
    const ast = parse("ls | grep foo");
    expect(ast).toEqual({
      type: "pipeline",
      commands: [
        { type: "command", name: "ls", args: [], redirects: [], assignments: [] },
        { type: "command", name: "grep", args: ["foo"], redirects: [], assignments: [] },
      ],
    });
  });

  it("parses && operator", () => {
    const ast = parse("mkdir dir && cd dir");
    expect(ast?.type).toBe("list");
    if (ast?.type === "list") {
      expect(ast.operator).toBe("&&");
      expect(ast.left).toEqual({
        type: "command", name: "mkdir", args: ["dir"], redirects: [], assignments: [],
      });
      expect(ast.right).toEqual({
        type: "command", name: "cd", args: ["dir"], redirects: [], assignments: [],
      });
    }
  });

  it("parses || operator", () => {
    const ast = parse("test -f foo || echo missing");
    expect(ast?.type).toBe("list");
    if (ast?.type === "list") {
      expect(ast.operator).toBe("||");
    }
  });

  it("parses semicolons", () => {
    const ast = parse("echo a; echo b");
    expect(ast?.type).toBe("list");
    if (ast?.type === "list") {
      expect(ast.operator).toBe(";");
    }
  });

  it("parses redirects", () => {
    const ast = parse("echo hello > output.txt");
    expect(ast?.type).toBe("command");
    if (ast?.type === "command") {
      expect(ast.name).toBe("echo");
      expect(ast.args).toEqual(["hello"]);
      expect(ast.redirects).toEqual([
        { type: "redirect", operator: ">", target: "output.txt" },
      ]);
    }
  });

  it("parses append redirect", () => {
    const ast = parse("echo line >> file.txt");
    if (ast?.type === "command") {
      expect(ast.redirects[0].operator).toBe(">>");
    }
  });

  it("parses variable assignments", () => {
    const ast = parse("FOO=bar echo $FOO");
    if (ast?.type === "command") {
      expect(ast.assignments).toEqual([
        { type: "assignment", name: "FOO", value: "bar" },
      ]);
      expect(ast.name).toBe("echo");
    }
  });

  it("parses quoted strings", () => {
    const ast = parse('echo "hello world"');
    if (ast?.type === "command") {
      expect(ast.args).toEqual(["hello world"]);
    }
  });

  it("returns null for empty input", () => {
    expect(parse("")).toBeNull();
    expect(parse("  ")).toBeNull();
  });
});
