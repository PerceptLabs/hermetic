import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFS } from "../src/backends/memory.js";
import type { HermeticFS, WatchEvent } from "../src/types.js";

let fs: HermeticFS;

beforeEach(() => {
  fs = new MemoryFS();
});

describe("writeFile / readFile", () => {
  it("writes and reads a text file", async () => {
    await fs.writeFile("/hello.txt", "hello world");
    const data = await fs.readFile("/hello.txt", "utf-8");
    expect(data).toBe("hello world");
  });

  it("writes and reads binary data", async () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    await fs.writeFile("/data.bin", buf);
    const data = await fs.readFile("/data.bin");
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it("overwrites existing file", async () => {
    await fs.writeFile("/file.txt", "first");
    await fs.writeFile("/file.txt", "second");
    expect(await fs.readFile("/file.txt", "utf-8")).toBe("second");
  });

  it("throws ENOENT for missing file", async () => {
    await expect(fs.readFile("/missing.txt")).rejects.toThrow("ENOENT");
  });

  it("throws EISDIR when reading a directory", async () => {
    await fs.mkdir("/dir");
    await expect(fs.readFile("/dir")).rejects.toThrow("EISDIR");
  });

  it("throws ENOENT when parent dir missing", async () => {
    await expect(fs.writeFile("/no/parent/file.txt", "data")).rejects.toThrow("ENOENT");
  });

  it("writes with recursive option creating parent dirs", async () => {
    await fs.writeFile("/a/b/c/file.txt", "deep", { recursive: true });
    expect(await fs.readFile("/a/b/c/file.txt", "utf-8")).toBe("deep");
  });
});

describe("mkdir", () => {
  it("creates a directory", async () => {
    await fs.mkdir("/mydir");
    const stat = await fs.stat("/mydir");
    expect(stat.type).toBe("directory");
  });

  it("throws EEXIST for existing directory", async () => {
    await fs.mkdir("/mydir");
    await expect(fs.mkdir("/mydir")).rejects.toThrow("EEXIST");
  });

  it("creates nested directories with recursive", async () => {
    await fs.mkdir("/a/b/c", { recursive: true });
    expect((await fs.stat("/a")).type).toBe("directory");
    expect((await fs.stat("/a/b")).type).toBe("directory");
    expect((await fs.stat("/a/b/c")).type).toBe("directory");
  });

  it("recursive mkdir on existing path is a no-op", async () => {
    await fs.mkdir("/a/b", { recursive: true });
    await fs.mkdir("/a/b", { recursive: true }); // should not throw
  });

  it("throws ENOENT for non-recursive with missing parent", async () => {
    await expect(fs.mkdir("/no/parent")).rejects.toThrow("ENOENT");
  });
});

describe("readdir", () => {
  it("lists directory contents", async () => {
    await fs.mkdir("/dir");
    await fs.writeFile("/dir/a.txt", "a");
    await fs.writeFile("/dir/b.txt", "b");
    const entries = await fs.readdir("/dir");
    expect(entries).toEqual(["a.txt", "b.txt"]);
  });

  it("returns empty array for empty directory", async () => {
    await fs.mkdir("/empty");
    expect(await fs.readdir("/empty")).toEqual([]);
  });

  it("lists root contents", async () => {
    await fs.writeFile("/root.txt", "r");
    await fs.mkdir("/subdir");
    const entries = await fs.readdir("/");
    expect(entries).toContain("root.txt");
    expect(entries).toContain("subdir");
  });

  it("throws ENOENT for missing directory", async () => {
    await expect(fs.readdir("/nope")).rejects.toThrow("ENOENT");
  });

  it("throws ENOTDIR for file path", async () => {
    await fs.writeFile("/file.txt", "f");
    await expect(fs.readdir("/file.txt")).rejects.toThrow("ENOTDIR");
  });

  it("only returns direct children, not nested", async () => {
    await fs.mkdir("/a/b/c", { recursive: true });
    await fs.writeFile("/a/b/c/deep.txt", "d");
    const entries = await fs.readdir("/a");
    expect(entries).toEqual(["b"]);
  });
});

describe("rmdir", () => {
  it("removes an empty directory", async () => {
    await fs.mkdir("/dir");
    await fs.rmdir("/dir");
    expect(await fs.exists("/dir")).toBe(false);
  });

  it("throws ENOTEMPTY for non-empty directory", async () => {
    await fs.mkdir("/dir");
    await fs.writeFile("/dir/file.txt", "f");
    await expect(fs.rmdir("/dir")).rejects.toThrow("ENOTEMPTY");
  });

  it("removes recursively", async () => {
    await fs.mkdir("/dir/sub", { recursive: true });
    await fs.writeFile("/dir/sub/file.txt", "f");
    await fs.rmdir("/dir", { recursive: true });
    expect(await fs.exists("/dir")).toBe(false);
    expect(await fs.exists("/dir/sub")).toBe(false);
    expect(await fs.exists("/dir/sub/file.txt")).toBe(false);
  });

  it("throws ENOENT for missing directory", async () => {
    await expect(fs.rmdir("/nope")).rejects.toThrow("ENOENT");
  });

  it("throws ENOTDIR for file", async () => {
    await fs.writeFile("/file.txt", "f");
    await expect(fs.rmdir("/file.txt")).rejects.toThrow("ENOTDIR");
  });
});

describe("stat / lstat", () => {
  it("returns file stats", async () => {
    await fs.writeFile("/file.txt", "hello");
    const stat = await fs.stat("/file.txt");
    expect(stat.type).toBe("file");
    expect(stat.size).toBe(5);
    expect(stat.mode).toBe(0o644);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  it("returns directory stats", async () => {
    await fs.mkdir("/dir");
    const stat = await fs.stat("/dir");
    expect(stat.type).toBe("directory");
    expect(stat.size).toBe(0);
  });

  it("stat follows symlinks", async () => {
    await fs.writeFile("/target.txt", "content");
    await fs.symlink("/target.txt", "/link");
    const stat = await fs.stat("/link");
    expect(stat.type).toBe("file");
    expect(stat.size).toBe(7);
  });

  it("lstat does not follow symlinks", async () => {
    await fs.writeFile("/target.txt", "content");
    await fs.symlink("/target.txt", "/link");
    const stat = await fs.lstat("/link");
    expect(stat.type).toBe("symlink");
    expect(stat.target).toBe("/target.txt");
  });

  it("throws ENOENT for missing path", async () => {
    await expect(fs.stat("/nope")).rejects.toThrow("ENOENT");
  });
});

describe("unlink", () => {
  it("removes a file", async () => {
    await fs.writeFile("/file.txt", "f");
    await fs.unlink("/file.txt");
    expect(await fs.exists("/file.txt")).toBe(false);
  });

  it("removes a symlink without affecting target", async () => {
    await fs.writeFile("/target.txt", "t");
    await fs.symlink("/target.txt", "/link");
    await fs.unlink("/link");
    expect(await fs.exists("/link")).toBe(false);
    expect(await fs.exists("/target.txt")).toBe(true);
  });

  it("throws ENOENT for missing file", async () => {
    await expect(fs.unlink("/nope")).rejects.toThrow("ENOENT");
  });

  it("throws EISDIR for directory", async () => {
    await fs.mkdir("/dir");
    await expect(fs.unlink("/dir")).rejects.toThrow("EISDIR");
  });
});

describe("rename", () => {
  it("renames a file", async () => {
    await fs.writeFile("/old.txt", "data");
    await fs.rename("/old.txt", "/new.txt");
    expect(await fs.exists("/old.txt")).toBe(false);
    expect(await fs.readFile("/new.txt", "utf-8")).toBe("data");
  });

  it("renames a directory with contents", async () => {
    await fs.mkdir("/old/sub", { recursive: true });
    await fs.writeFile("/old/sub/file.txt", "f");
    await fs.rename("/old", "/new");
    expect(await fs.exists("/old")).toBe(false);
    expect(await fs.readFile("/new/sub/file.txt", "utf-8")).toBe("f");
  });

  it("throws ENOENT for missing source", async () => {
    await expect(fs.rename("/nope", "/other")).rejects.toThrow("ENOENT");
  });
});

describe("copyFile", () => {
  it("copies file contents", async () => {
    await fs.writeFile("/src.txt", "copy me");
    await fs.copyFile("/src.txt", "/dest.txt");
    expect(await fs.readFile("/dest.txt", "utf-8")).toBe("copy me");
    // Original still exists
    expect(await fs.readFile("/src.txt", "utf-8")).toBe("copy me");
  });
});

describe("exists", () => {
  it("returns true for existing paths", async () => {
    await fs.writeFile("/file.txt", "f");
    await fs.mkdir("/dir");
    expect(await fs.exists("/file.txt")).toBe(true);
    expect(await fs.exists("/dir")).toBe(true);
    expect(await fs.exists("/")).toBe(true);
  });

  it("returns false for missing paths", async () => {
    expect(await fs.exists("/nope")).toBe(false);
  });
});

describe("chmod / utimes", () => {
  it("changes file mode", async () => {
    await fs.writeFile("/file.txt", "f");
    await fs.chmod("/file.txt", 0o755);
    const stat = await fs.stat("/file.txt");
    expect(stat.mode).toBe(0o755);
  });

  it("changes timestamps", async () => {
    await fs.writeFile("/file.txt", "f");
    const atime = new Date("2020-01-01");
    const mtime = new Date("2021-06-15");
    await fs.utimes("/file.txt", atime, mtime);
    const stat = await fs.stat("/file.txt");
    expect(stat.atime.getTime()).toBe(atime.getTime());
    expect(stat.mtime.getTime()).toBe(mtime.getTime());
  });
});

describe("symlinks", () => {
  it("creates and reads a symlink", async () => {
    await fs.writeFile("/target.txt", "content");
    await fs.symlink("/target.txt", "/link");
    const target = await fs.readlink("/link");
    expect(target).toBe("/target.txt");
  });

  it("readFile follows symlinks", async () => {
    await fs.writeFile("/target.txt", "symlinked content");
    await fs.symlink("/target.txt", "/link");
    expect(await fs.readFile("/link", "utf-8")).toBe("symlinked content");
  });

  it("writeFile through symlink updates target", async () => {
    await fs.writeFile("/target.txt", "original");
    await fs.symlink("/target.txt", "/link");
    await fs.writeFile("/link", "updated");
    expect(await fs.readFile("/target.txt", "utf-8")).toBe("updated");
  });

  it("chains multiple symlinks", async () => {
    await fs.writeFile("/final.txt", "deep");
    await fs.symlink("/final.txt", "/link1");
    await fs.symlink("/link1", "/link2");
    await fs.symlink("/link2", "/link3");
    expect(await fs.readFile("/link3", "utf-8")).toBe("deep");
  });

  it("throws ELOOP for circular symlinks", async () => {
    await fs.symlink("/b", "/a");
    await fs.symlink("/a", "/b");
    await expect(fs.readFile("/a", "utf-8")).rejects.toThrow("ELOOP");
  });

  it("throws ELOOP after 40 hops", async () => {
    // Create a long chain of symlinks that eventually loops
    await fs.symlink("/link0", "/link40");
    for (let i = 0; i < 40; i++) {
      await fs.symlink(`/link${i + 1}`, `/link${i}`);
    }
    await expect(fs.readFile("/link0")).rejects.toThrow("ELOOP");
  });

  it("handles relative symlinks", async () => {
    await fs.mkdir("/dir");
    await fs.writeFile("/dir/target.txt", "relative");
    await fs.symlink("target.txt", "/dir/link");
    expect(await fs.readFile("/dir/link", "utf-8")).toBe("relative");
  });

  it("throws EEXIST when symlink target path exists", async () => {
    await fs.writeFile("/file.txt", "f");
    await expect(fs.symlink("/other", "/file.txt")).rejects.toThrow("EEXIST");
  });

  it("readlink throws on non-symlink", async () => {
    await fs.writeFile("/file.txt", "f");
    await expect(fs.readlink("/file.txt")).rejects.toThrow("EINVAL");
  });
});

describe("watch", () => {
  it("notifies on file creation", async () => {
    const events: WatchEvent[] = [];
    fs.watch("/", (e) => events.push(e));

    await fs.writeFile("/new.txt", "n");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("create");
    expect(events[0].path).toBe("/new.txt");
  });

  it("notifies on file modification", async () => {
    await fs.writeFile("/file.txt", "v1");
    const events: WatchEvent[] = [];
    fs.watch("/file.txt", (e) => events.push(e));

    await fs.writeFile("/file.txt", "v2");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("modify");
  });

  it("notifies on file deletion", async () => {
    await fs.writeFile("/file.txt", "f");
    const events: WatchEvent[] = [];
    fs.watch("/", (e) => events.push(e));

    await fs.unlink("/file.txt");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("delete");
  });

  it("unsubscribes correctly", async () => {
    const events: WatchEvent[] = [];
    const unsub = fs.watch("/", (e) => events.push(e));

    await fs.writeFile("/a.txt", "a");
    unsub();
    await fs.writeFile("/b.txt", "b");

    expect(events).toHaveLength(1);
  });
});

describe("path edge cases", () => {
  it("normalizes double slashes", async () => {
    await fs.mkdir("/foo");
    await fs.writeFile("//foo//bar.txt", "data");
    expect(await fs.readFile("/foo/bar.txt", "utf-8")).toBe("data");
  });

  it("normalizes trailing slashes", async () => {
    await fs.mkdir("/dir/");
    expect(await fs.exists("/dir")).toBe(true);
  });

  it("resolves . and ..", async () => {
    await fs.mkdir("/a/b", { recursive: true });
    await fs.writeFile("/a/b/file.txt", "f");
    expect(await fs.readFile("/a/./b/../b/./file.txt", "utf-8")).toBe("f");
  });
});
