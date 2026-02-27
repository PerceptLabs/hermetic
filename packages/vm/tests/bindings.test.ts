import { describe, it, expect } from "vitest";
import { generateBindings } from "../src/bindings.js";

describe("generateBindings", () => {
  it("includes RPC infrastructure", () => {
    const code = generateBindings({});
    expect(code).toContain("__hermetic_port");
    expect(code).toContain("__call");
    expect(code).toContain("__handleMessage");
    expect(code).toContain("hermetic-vm-init");
  });

  it("includes console bindings by default", () => {
    const code = generateBindings({});
    expect(code).toContain("console");
    expect(code).toContain('"log"');
    expect(code).toContain('"error"');
    expect(code).toContain('"warn"');
    expect(code).toContain('"info"');
  });

  it("excludes console bindings when disabled", () => {
    const code = generateBindings({ console: false });
    expect(code).not.toContain("Sealed console");
  });

  it("includes fetch bindings by default", () => {
    const code = generateBindings({});
    expect(code).toContain("fetch");
    expect(code).toContain("Request");
  });

  it("excludes fetch bindings when disabled", () => {
    const code = generateBindings({ fetch: false });
    expect(code).not.toContain("Sealed fetch");
  });

  it("includes fs bindings when enabled", () => {
    const code = generateBindings({ fs: true });
    expect(code).toContain("readFile");
    expect(code).toContain("writeFile");
    expect(code).toContain("readdir");
    expect(code).toContain("mkdir");
  });

  it("excludes fs bindings by default", () => {
    const code = generateBindings({});
    expect(code).not.toContain("Sealed fs");
  });

  it("generates valid JavaScript syntax", () => {
    const code = generateBindings({ console: true, fetch: true, fs: true });
    // Should not throw when parsed (basic validation)
    expect(() => new Function(code)).not.toThrow();
  });
});
