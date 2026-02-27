import { describe, it, expect } from "vitest";
import {
  serializeError,
  deserializeError,
  isHermeticMessage,
  isRequestMessage,
  isResponseMessage,
  isStreamMessage,
  isNotificationMessage,
  HermeticError,
  ENOENT,
} from "../src/index.js";

describe("serializeError / deserializeError", () => {
  it("round-trips a basic Error", () => {
    const err = new Error("something failed");
    const serialized = serializeError(err);
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("something failed");
    expect(serialized.stack).toBeDefined();

    const deserialized = deserializeError(serialized);
    expect(deserialized).toBeInstanceOf(Error);
    expect(deserialized.name).toBe("Error");
    expect(deserialized.message).toBe("something failed");
  });

  it("round-trips a HermeticError with POSIX code", () => {
    const err = ENOENT("/foo/bar", "open");
    const serialized = serializeError(err);
    expect(serialized.name).toBe("ENOENT");
    expect(serialized.code).toBe("ENOENT");
    expect(serialized.path).toBe("/foo/bar");
    expect(serialized.syscall).toBe("open");

    const deserialized = deserializeError(serialized);
    expect(deserialized.name).toBe("ENOENT");
    expect((deserialized as HermeticError).code).toBe("ENOENT");
    expect((deserialized as HermeticError).path).toBe("/foo/bar");
  });

  it("serializes non-Error values", () => {
    expect(serializeError("oops")).toEqual({ name: "Error", message: "oops" });
    expect(serializeError(42)).toEqual({ name: "Error", message: "42" });
    expect(serializeError(null)).toEqual({ name: "Error", message: "null" });
  });
});

describe("message discrimination helpers", () => {
  it("identifies hermetic messages", () => {
    expect(isHermeticMessage({ __hermetic: true, ns: "fs", id: "1", method: "read", args: [] })).toBe(true);
    expect(isHermeticMessage({ ns: "fs" })).toBe(false);
    expect(isHermeticMessage(null)).toBe(false);
    expect(isHermeticMessage("string")).toBe(false);
    expect(isHermeticMessage(42)).toBe(false);
  });

  it("discriminates request messages", () => {
    const req = { __hermetic: true as const, ns: "fs", id: "1", method: "read", args: [] };
    expect(isRequestMessage(req)).toBe(true);

    const resp = { __hermetic: true as const, ns: "fs", id: "1", ok: true as const, value: 42 };
    expect(isRequestMessage(resp)).toBe(false);
  });

  it("discriminates response messages", () => {
    const okResp = { __hermetic: true as const, ns: "fs", id: "1", ok: true as const, value: 42 };
    expect(isResponseMessage(okResp)).toBe(true);

    const errResp = {
      __hermetic: true as const,
      ns: "fs",
      id: "1",
      ok: false as const,
      error: { name: "Error", message: "fail" },
    };
    expect(isResponseMessage(errResp)).toBe(true);
  });

  it("discriminates stream messages", () => {
    const stream = { __hermetic: true as const, ns: "fs", id: "1", stream: "chunk" as const };
    expect(isStreamMessage(stream)).toBe(true);
  });

  it("discriminates notification messages", () => {
    const notif = { __hermetic: true as const, ns: "fs", event: "change", data: "/foo" };
    expect(isNotificationMessage(notif)).toBe(true);
  });
});
