import { describe, it, expect } from "vitest";
import { HermeticChannel } from "../src/index.js";

function createPair(timeout?: number) {
  const { port1, port2 } = new MessageChannel();
  const caller = new HermeticChannel(port1, timeout);
  const handler = new HermeticChannel(port2, timeout);
  return { caller, handler };
}

describe("HermeticChannel", () => {
  it("sends request and receives response", async () => {
    const { caller, handler } = createPair();

    handler.handle("math", {
      add: async (a: unknown, b: unknown) => (a as number) + (b as number),
    });

    const result = await caller.call("math", "add", [2, 3]);
    expect(result).toBe(5);

    caller.dispose();
    handler.dispose();
  });

  it("propagates errors across channel", async () => {
    const { caller, handler } = createPair();

    handler.handle("test", {
      fail: async () => {
        throw new Error("handler error");
      },
    });

    await expect(caller.call("test", "fail", [])).rejects.toThrow("handler error");

    caller.dispose();
    handler.dispose();
  });

  it("propagates error codes across channel", async () => {
    const { caller, handler } = createPair();

    handler.handle("fs", {
      read: async () => {
        const err = new Error("ENOENT: no such file") as Error & { code: string; path: string };
        err.code = "ENOENT";
        err.path = "/missing.txt";
        throw err;
      },
    });

    try {
      await caller.call("fs", "read", []);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as Error & { code?: string; path?: string };
      expect(err.message).toContain("ENOENT");
      expect(err.code).toBe("ENOENT");
      expect(err.path).toBe("/missing.txt");
    }

    caller.dispose();
    handler.dispose();
  });

  it("times out on unresponsive handler", async () => {
    const { caller, handler } = createPair(100); // 100ms timeout

    // Register a handler that never responds
    handler.handle("slow", {
      noop: () => new Promise(() => {}), // never resolves
    });

    await expect(caller.call("slow", "noop", [])).rejects.toThrow("timeout");

    caller.dispose();
    handler.dispose();
  });

  it("transfers ArrayBuffer without copying", async () => {
    const { caller, handler } = createPair();

    handler.handle("buf", {
      echo: async (data: unknown) => data,
    });

    const original = new ArrayBuffer(1024);
    const view = new Uint8Array(original);
    view[0] = 42;

    const result = await caller.call("buf", "echo", [original]);
    expect(result).toBeInstanceOf(ArrayBuffer);
    const resultView = new Uint8Array(result as ArrayBuffer);
    expect(resultView[0]).toBe(42);

    caller.dispose();
    handler.dispose();
  });

  it("handles rapid concurrent requests", async () => {
    const { caller, handler } = createPair();

    handler.handle("math", {
      double: async (n: unknown) => (n as number) * 2,
    });

    const promises = Array.from({ length: 100 }, (_, i) =>
      caller.call("math", "double", [i]),
    );
    const results = await Promise.all(promises);

    for (let i = 0; i < 100; i++) {
      expect(results[i]).toBe(i * 2);
    }

    caller.dispose();
    handler.dispose();
  });

  it("rejects pending requests on dispose", async () => {
    const { caller, handler } = createPair();

    handler.handle("slow", {
      wait: async () => new Promise(() => {}), // never resolves
    });

    const promise = caller.call("slow", "wait", []);

    // Dispose while request is pending
    caller.dispose();

    await expect(promise).rejects.toThrow("Channel disposed");

    handler.dispose();
  });

  it("ignores non-hermetic messages", async () => {
    const { port1, port2 } = new MessageChannel();
    const caller = new HermeticChannel(port1);
    const handler = new HermeticChannel(port2);

    handler.handle("test", {
      ping: async () => "pong",
    });

    // Send non-hermetic messages — should be silently ignored
    port1.postMessage({ type: "not-hermetic" });
    port1.postMessage(null);
    port1.postMessage("just a string");

    // Real RPC should still work
    const result = await caller.call("test", "ping", []);
    expect(result).toBe("pong");

    caller.dispose();
    handler.dispose();
  });

  it("rejects calls to unknown methods", async () => {
    const { caller, handler } = createPair();

    handler.handle("test", {
      known: async () => "ok",
    });

    await expect(caller.call("test", "unknown", [])).rejects.toThrow("Unknown method");

    caller.dispose();
    handler.dispose();
  });

  it("rejects calls after dispose", async () => {
    const { caller, handler } = createPair();
    caller.dispose();

    await expect(caller.call("test", "ping", [])).rejects.toThrow("Channel disposed");

    handler.dispose();
  });

  it("sends and receives notifications", async () => {
    const { caller, handler } = createPair();

    const received: unknown[] = [];
    caller.on("test.event", (data) => received.push(data));

    handler.notify("test", "event", { foo: "bar" });

    // Wait for async message delivery
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([{ foo: "bar" }]);

    caller.dispose();
    handler.dispose();
  });

  it("unsubscribes from notifications", async () => {
    const { caller, handler } = createPair();

    const received: unknown[] = [];
    const unsub = caller.on("test.event", (data) => received.push(data));

    handler.notify("test", "event", "first");
    await new Promise((r) => setTimeout(r, 50));

    unsub();
    handler.notify("test", "event", "second");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["first"]);

    caller.dispose();
    handler.dispose();
  });
});
