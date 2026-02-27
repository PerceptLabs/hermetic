import { describe, it, expect } from "vitest";
import { Hermetic } from "../src/runtime.js";

describe("Hermetic Runtime", () => {
  it("exports Hermetic class", () => {
    expect(Hermetic).toBeDefined();
    expect(typeof Hermetic).toBe("function");
  });

  it("Hermetic.create() returns runtime instance", async () => {
    const runtime = await Hermetic.create();
    expect(runtime).toBeDefined();
    expect(runtime.fs).toBeDefined();
    expect(runtime.shell).toBeDefined();
    expect(runtime.proc).toBeDefined();
    expect(typeof runtime.dispose).toBe("function");
    runtime.dispose();
  });

  it("shell can execute basic commands", async () => {
    const runtime = await Hermetic.create();
    const result = await runtime.shell.exec("echo hello");
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
    runtime.dispose();
  });

  it("fs operations work through runtime", async () => {
    const runtime = await Hermetic.create();
    await runtime.fs.writeFile("/test.txt", "content");
    const data = await runtime.fs.readFile("/test.txt", "utf-8");
    expect(data).toBe("content");
    runtime.dispose();
  });

  it("dispose cleans up all subsystems", async () => {
    const runtime = await Hermetic.create();
    expect(() => runtime.dispose()).not.toThrow();
  });
});
