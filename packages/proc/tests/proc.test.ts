import { describe, it, expect } from "vitest";
import { HermeticProc } from "../src/proc.js";

describe("HermeticProc", () => {
  it("exports HermeticProc class", () => {
    expect(HermeticProc).toBeDefined();
    expect(typeof HermeticProc).toBe("function");
  });

  it("instantiates and has required methods", () => {
    const proc = new HermeticProc();
    expect(typeof proc.spawn).toBe("function");
    expect(typeof proc.waitpid).toBe("function");
    expect(typeof proc.kill).toBe("function");
    expect(typeof proc.list).toBe("function");
    expect(typeof proc.dispose).toBe("function");
  });

  it("list returns empty array initially", () => {
    const proc = new HermeticProc();
    expect(proc.list()).toEqual([]);
    proc.dispose();
  });

  it("kill on nonexistent pid does not throw", () => {
    const proc = new HermeticProc();
    expect(() => proc.kill(999)).not.toThrow();
    proc.dispose();
  });

  it("waitpid on nonexistent pid rejects", async () => {
    const proc = new HermeticProc();
    await expect(proc.waitpid(999)).rejects.toThrow("No such process");
    proc.dispose();
  });
});
