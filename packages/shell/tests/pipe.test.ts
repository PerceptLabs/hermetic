import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFS } from "@hermetic/fs";
import { HermeticShell } from "../src/shell.js";

let fs: MemoryFS;
let shell: HermeticShell;

beforeEach(() => {
  fs = new MemoryFS();
  shell = new HermeticShell(fs, { cwd: "/" });
});

describe("Shell Piping", () => {
  it("pipes ls output through grep", async () => {
    await fs.writeFile("/foo.txt", "hello");
    await fs.writeFile("/bar.js", "world");
    await fs.writeFile("/baz.txt", "data");
    const result = await shell.exec("ls / | grep .js");
    expect(result.stdout.trim()).toBe("bar.js");
  });

  it("pipes echo through grep", async () => {
    const result = await shell.exec("echo hello world | grep hello");
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("pipes echo through wc", async () => {
    const result = await shell.exec("echo hello | wc");
    expect(result.stdout).toContain("1"); // 1 line
    expect(result.exitCode).toBe(0);
  });

  it("three-stage pipe: ls | sort | head", async () => {
    await fs.writeFile("/c.txt", "");
    await fs.writeFile("/a.txt", "");
    await fs.writeFile("/b.txt", "");
    const result = await shell.exec("ls / | sort | head -n2");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toEqual(["a.txt", "b.txt"]);
  });

  it("cat file | sort works", async () => {
    await fs.writeFile("/data.txt", "banana\napple\ncherry\n");
    const result = await shell.exec("cat /data.txt | sort");
    expect(result.stdout.trim()).toBe("apple\nbanana\ncherry");
  });

  it("cat file | grep works", async () => {
    await fs.writeFile("/log.txt", "error: bad\ninfo: good\nerror: worse\n");
    const result = await shell.exec("cat /log.txt | grep error");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("error: bad");
    expect(lines[1]).toBe("error: worse");
  });

  it("pipe preserves exit code of last command", async () => {
    const result = await shell.exec("echo hello | grep notfound");
    expect(result.exitCode).toBe(1); // grep returns 1 when no matches
  });

  it("cat | sort | uniq deduplicates", async () => {
    await fs.writeFile("/dup.txt", "a\nb\na\nb\nc\n");
    const result = await shell.exec("cat /dup.txt | sort | uniq");
    expect(result.stdout.trim()).toBe("a\nb\nc");
  });

  it("cat reads from stdin when no file args", async () => {
    const result = await shell.exec("echo piped data | cat");
    expect(result.stdout.trim()).toBe("piped data");
  });

  it("tail -n2 gets last 2 lines", async () => {
    await fs.writeFile("/nums.txt", "1\n2\n3\n4\n5\n");
    const result = await shell.exec("cat /nums.txt | tail -n2");
    expect(result.stdout.trim()).toBe("4\n5");
  });
});
