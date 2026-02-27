import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFS } from "@hermetic/fs";
import { HermeticShell } from "../src/shell.js";

let fs: MemoryFS;
let shell: HermeticShell;

beforeEach(() => {
  fs = new MemoryFS();
  shell = new HermeticShell(fs, { cwd: "/" });
});

describe("Shell Builtins", () => {
  it("echo outputs args", async () => {
    const result = await shell.exec("echo hello world");
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("pwd shows current directory", async () => {
    const result = await shell.exec("pwd");
    expect(result.stdout).toBe("/\n");
  });

  it("cd changes directory", async () => {
    await fs.mkdir("/home");
    await shell.exec("cd /home");
    expect(shell.cwd()).toBe("/home");
  });

  it("cd to nonexistent dir fails", async () => {
    const result = await shell.exec("cd /nope");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no such file");
  });

  it("ls lists directory", async () => {
    await fs.mkdir("/dir");
    await fs.writeFile("/dir/a.txt", "a");
    await fs.writeFile("/dir/b.txt", "b");
    const result = await shell.exec("ls /dir");
    expect(result.stdout).toContain("a.txt");
    expect(result.stdout).toContain("b.txt");
  });

  it("cat reads file", async () => {
    await fs.writeFile("/hello.txt", "Hello World");
    const result = await shell.exec("cat /hello.txt");
    expect(result.stdout).toBe("Hello World");
  });

  it("mkdir creates directory", async () => {
    await shell.exec("mkdir /newdir");
    expect(await fs.exists("/newdir")).toBe(true);
  });

  it("mkdir -p creates nested directories", async () => {
    await shell.exec("mkdir -p /a/b/c");
    expect(await fs.exists("/a/b/c")).toBe(true);
  });

  it("touch creates file", async () => {
    await shell.exec("touch /newfile.txt");
    expect(await fs.exists("/newfile.txt")).toBe(true);
  });

  it("rm removes file", async () => {
    await fs.writeFile("/file.txt", "f");
    await shell.exec("rm /file.txt");
    expect(await fs.exists("/file.txt")).toBe(false);
  });

  it("rm -rf removes directory", async () => {
    await fs.mkdir("/dir/sub", { recursive: true });
    await fs.writeFile("/dir/sub/file.txt", "f");
    await shell.exec("rm -rf /dir");
    expect(await fs.exists("/dir")).toBe(false);
  });

  it("cp copies file", async () => {
    await fs.writeFile("/src.txt", "content");
    await shell.exec("cp /src.txt /dest.txt");
    expect(await fs.readFile("/dest.txt", "utf-8")).toBe("content");
  });

  it("mv renames file", async () => {
    await fs.writeFile("/old.txt", "data");
    await shell.exec("mv /old.txt /new.txt");
    expect(await fs.exists("/old.txt")).toBe(false);
    expect(await fs.readFile("/new.txt", "utf-8")).toBe("data");
  });

  it("env shows environment", async () => {
    const result = await shell.exec("env");
    expect(result.stdout).toContain("HOME=/home");
    expect(result.stdout).toContain("USER=hermetic");
  });

  it("export sets env variable", async () => {
    await shell.exec("export FOO=bar");
    expect(shell.env().FOO).toBe("bar");
  });

  it("&& chains on success", async () => {
    const result = await shell.exec("echo first && echo second");
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
  });

  it("&& short-circuits on failure", async () => {
    const result = await shell.exec("cat /nonexistent && echo should-not-run");
    expect(result.stdout).not.toContain("should-not-run");
    expect(result.exitCode).not.toBe(0);
  });

  it("redirect > writes to file", async () => {
    await shell.exec("echo hello > /out.txt");
    expect(await fs.readFile("/out.txt", "utf-8")).toBe("hello\n");
  });

  it("unknown command returns 127", async () => {
    const result = await shell.exec("nonexistent");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  it("variable expansion works", async () => {
    await shell.exec("export NAME=World");
    const result = await shell.exec("echo $NAME");
    expect(result.stdout).toBe("World\n");
  });
});
