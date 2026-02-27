import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFS } from "@hermetic/fs";
import { HermeticShell } from "../src/shell.js";

let fs: MemoryFS;
let shell: HermeticShell;

beforeEach(async () => {
  fs = new MemoryFS();
  shell = new HermeticShell(fs, { cwd: "/" });

  await fs.writeFile("/foo.txt", "foo content");
  await fs.writeFile("/bar.txt", "bar content");
  await fs.writeFile("/baz.js", "baz content");
  await fs.mkdir("/src");
  await fs.writeFile("/src/app.ts", "app");
  await fs.writeFile("/src/main.ts", "main");
  await fs.writeFile("/src/style.css", "style");
});

describe("Glob Expansion", () => {
  it("ls *.txt matches text files", async () => {
    const result = await shell.exec("ls *.txt");
    expect(result.stdout).toContain("foo.txt");
    expect(result.stdout).toContain("bar.txt");
    expect(result.stdout).not.toContain("baz.js");
  });

  it("ls *.js matches js files", async () => {
    const result = await shell.exec("ls *.js");
    expect(result.stdout.trim()).toBe("baz.js");
  });

  it("cat src/*.ts reads matching files", async () => {
    const result = await shell.exec("cat src/*.ts");
    expect(result.stdout).toContain("app");
    expect(result.stdout).toContain("main");
  });

  it("no match returns literal (bash behavior)", async () => {
    const result = await shell.exec("echo *.xyz");
    expect(result.stdout.trim()).toBe("*.xyz");
  });

  it("? matches single character", async () => {
    await fs.writeFile("/a1.txt", "");
    await fs.writeFile("/a2.txt", "");
    await fs.writeFile("/ab.txt", "");
    const result = await shell.exec("ls /a?.txt");
    expect(result.stdout).toContain("a1.txt");
    expect(result.stdout).toContain("a2.txt");
    expect(result.stdout).toContain("ab.txt");
  });

  it("glob works with pipe", async () => {
    const result = await shell.exec("ls /src/*.ts | sort");
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toContain("app.ts");
    expect(lines[1]).toContain("main.ts");
  });

  it("rm *.txt removes matching files", async () => {
    await shell.exec("rm *.txt");
    expect(await fs.exists("/foo.txt")).toBe(false);
    expect(await fs.exists("/bar.txt")).toBe(false);
    expect(await fs.exists("/baz.js")).toBe(true);
  });
});
