import { describe, it, expect } from "vitest";
import {
  normalizePath,
  joinPath,
  dirname,
  basename,
  extname,
  isAbsolute,
  resolvePath,
  guessMimeType,
} from "../src/index.js";

describe("normalizePath", () => {
  it("handles root", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("removes trailing slashes", () => {
    expect(normalizePath("/foo/bar/")).toBe("/foo/bar");
  });

  it("removes double slashes", () => {
    expect(normalizePath("/foo//bar///baz")).toBe("/foo/bar/baz");
  });

  it("resolves . segments", () => {
    expect(normalizePath("/foo/./bar")).toBe("/foo/bar");
    expect(normalizePath("/./foo")).toBe("/foo");
  });

  it("resolves .. segments", () => {
    expect(normalizePath("/foo/bar/../baz")).toBe("/foo/baz");
    expect(normalizePath("/foo/../..")).toBe("/");
  });

  it("does not go above root", () => {
    expect(normalizePath("/..")).toBe("/");
    expect(normalizePath("/../../../foo")).toBe("/foo");
  });

  it("handles relative paths with ..", () => {
    expect(normalizePath("foo/../bar")).toBe("bar");
    expect(normalizePath("foo/bar/../../baz")).toBe("baz");
  });

  it("handles single segment", () => {
    expect(normalizePath("/foo")).toBe("/foo");
  });
});

describe("joinPath", () => {
  it("joins multiple segments", () => {
    expect(joinPath("/foo", "bar", "baz")).toBe("/foo/bar/baz");
  });

  it("handles absolute second segment", () => {
    // joinPath concatenates; normalizePath keeps leading /
    expect(joinPath("/foo", "/bar")).toBe("/foo/bar");
  });

  it("handles empty args", () => {
    expect(joinPath()).toBe(".");
  });
});

describe("dirname", () => {
  it("returns parent directory", () => {
    expect(dirname("/foo/bar")).toBe("/foo");
    expect(dirname("/foo/bar/baz")).toBe("/foo/bar");
  });

  it("returns / for root-level files", () => {
    expect(dirname("/foo")).toBe("/");
  });

  it("returns / for root", () => {
    expect(dirname("/")).toBe("/");
  });
});

describe("basename", () => {
  it("returns last segment", () => {
    expect(basename("/foo/bar")).toBe("bar");
    expect(basename("/foo/bar/baz.ts")).toBe("baz.ts");
  });

  it("strips extension if provided", () => {
    expect(basename("/foo/bar.ts", ".ts")).toBe("bar");
  });

  it("returns / for root", () => {
    expect(basename("/")).toBe("/");
  });
});

describe("extname", () => {
  it("returns file extension", () => {
    expect(extname("/foo/bar.ts")).toBe(".ts");
    expect(extname("/foo/bar.test.ts")).toBe(".ts");
  });

  it("returns empty for no extension", () => {
    expect(extname("/foo/bar")).toBe("");
  });

  it("returns empty for dotfiles", () => {
    expect(extname("/foo/.gitignore")).toBe("");
  });
});

describe("isAbsolute", () => {
  it("identifies absolute paths", () => {
    expect(isAbsolute("/foo")).toBe(true);
    expect(isAbsolute("/")).toBe(true);
  });

  it("identifies relative paths", () => {
    expect(isAbsolute("foo")).toBe(false);
    expect(isAbsolute("./foo")).toBe(false);
    expect(isAbsolute("")).toBe(false);
  });
});

describe("resolvePath", () => {
  it("resolves relative to cwd", () => {
    expect(resolvePath("/home", "./foo/bar")).toBe("/home/foo/bar");
    expect(resolvePath("/home", "foo")).toBe("/home/foo");
  });

  it("returns absolute paths unchanged", () => {
    expect(resolvePath("/home", "/absolute")).toBe("/absolute");
  });

  it("resolves .. in relative paths", () => {
    expect(resolvePath("/home/user", "../other")).toBe("/home/other");
  });
});

describe("guessMimeType", () => {
  it("identifies common web types", () => {
    expect(guessMimeType("/foo.html")).toBe("text/html");
    expect(guessMimeType("/foo.css")).toBe("text/css");
    expect(guessMimeType("/foo.js")).toBe("application/javascript");
    expect(guessMimeType("/foo.json")).toBe("application/json");
    expect(guessMimeType("/foo.ts")).toBe("application/typescript");
    expect(guessMimeType("/foo.svg")).toBe("image/svg+xml");
    expect(guessMimeType("/foo.png")).toBe("image/png");
    expect(guessMimeType("/foo.wasm")).toBe("application/wasm");
  });

  it("returns octet-stream for unknown extensions", () => {
    expect(guessMimeType("/foo.xyz")).toBe("application/octet-stream");
    expect(guessMimeType("/foo")).toBe("application/octet-stream");
  });
});
