import { describe, it, expect, afterEach } from "vitest";
import { Hermetic } from "../src/runtime.js";

let runtime: Hermetic;

afterEach(() => {
  runtime?.dispose();
});

describe("Hermetic Runtime", () => {
  it("exports Hermetic class", () => {
    expect(Hermetic).toBeDefined();
    expect(typeof Hermetic).toBe("function");
  });

  it("Hermetic.create() returns runtime instance", async () => {
    runtime = await Hermetic.create();
    expect(runtime).toBeDefined();
    expect(runtime.fs).toBeDefined();
    expect(runtime.shell).toBeDefined();
    expect(runtime.proc).toBeDefined();
    expect(runtime.vm).toBeDefined();
    expect(runtime.pm).toBeDefined();
    expect(typeof runtime.dispose).toBe("function");
  });

  it("shell can execute basic commands", async () => {
    runtime = await Hermetic.create();
    const result = await runtime.shell.exec("echo hello");
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("fs operations work through runtime", async () => {
    runtime = await Hermetic.create();
    await runtime.fs.writeFile("/test.txt", "content");
    const data = await runtime.fs.readFile("/test.txt", "utf-8");
    expect(data).toBe("content");
  });

  it("dispose cleans up all subsystems", async () => {
    runtime = await Hermetic.create();
    expect(() => runtime.dispose()).not.toThrow();
  });

  it("shell pipe chain works end-to-end", async () => {
    runtime = await Hermetic.create();
    await runtime.fs.writeFile("/data.txt", "cherry\napple\nbanana\n");
    const result = await runtime.shell.exec("cat /data.txt | sort");
    expect(result.stdout.trim()).toBe("apple\nbanana\ncherry");
  });

  it("glob expansion works through runtime shell", async () => {
    runtime = await Hermetic.create();
    await runtime.fs.writeFile("/a.txt", "a");
    await runtime.fs.writeFile("/b.txt", "b");
    await runtime.fs.writeFile("/c.js", "c");
    const result = await runtime.shell.exec("ls *.txt");
    expect(result.stdout).toContain("a.txt");
    expect(result.stdout).toContain("b.txt");
    expect(result.stdout).not.toContain("c.js");
  });

  it("node executes script through runtime shell", async () => {
    runtime = await Hermetic.create();
    await runtime.fs.writeFile("/hello.js", 'console.log("from node")');
    const result = await runtime.shell.exec("node /hello.js");
    expect(result.stdout.trim()).toBe("from node");
    expect(result.exitCode).toBe(0);
  });

  it("accepts custom env and cwd options", async () => {
    runtime = await Hermetic.create({ env: { CUSTOM: "val" }, cwd: "/" });
    const result = await runtime.shell.exec("echo $CUSTOM");
    expect(result.stdout.trim()).toBe("val");
  });

  it("multiple runtimes can coexist", async () => {
    const runtime1 = await Hermetic.create();
    const runtime2 = await Hermetic.create();
    await runtime1.fs.writeFile("/r1.txt", "runtime1");
    await runtime2.fs.writeFile("/r2.txt", "runtime2");
    expect(await runtime1.fs.exists("/r1.txt")).toBe(true);
    expect(await runtime1.fs.exists("/r2.txt")).toBe(false);
    expect(await runtime2.fs.exists("/r2.txt")).toBe(true);
    expect(await runtime2.fs.exists("/r1.txt")).toBe(false);
    runtime1.dispose();
    runtime2.dispose();
  });
});
