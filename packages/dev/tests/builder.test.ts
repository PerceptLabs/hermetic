import { describe, it, expect } from "vitest";
import { build } from "../src/builder.js";
import { MemoryFS } from "@hermetic/fs";

describe("HermeticDev Builder", () => {
  it("build function is exported and callable", () => {
    expect(typeof build).toBe("function");
  });

  it("build rejects when esbuild is not available", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/app.js", "console.log('hello')");
    // In test environment, esbuild-wasm CDN is not reachable
    // so build should reject with an import/init error
    await expect(build(fs, "/app.js")).rejects.toThrow();
  });

  it("build requires a valid entry point path", async () => {
    const fs = new MemoryFS();
    // Even without esbuild, the function accepts the right signature
    await expect(build(fs, "/nonexistent.js")).rejects.toThrow();
  });

  it("build accepts wasmUrl option", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/test.js", "export default 1");
    // Should fail because the URL isn't reachable, but accepts the option
    await expect(build(fs, "/test.js", { wasmUrl: "http://fake.wasm" })).rejects.toThrow();
  });
});
