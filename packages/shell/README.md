# @hermetic/shell

Bash-like shell interpreter with piping, glob expansion, redirects, and builtins.

## Install

```bash
npm install @hermetic/shell
```

## Usage

```ts
import { HermeticShell } from "@hermetic/shell";
import { MemoryFS } from "@hermetic/fs";

const fs = new MemoryFS();
const shell = new HermeticShell(fs, { cwd: "/" });

await fs.writeFile("/data.txt", "cherry\napple\nbanana\n");
const result = await shell.exec("cat /data.txt | sort | head -n2");
// result.stdout === "apple\nbanana\n"
```

## Builtins

echo, pwd, cd, ls, cat, mkdir, rm, cp, mv, touch, env, export, which, clear, exit, grep, sort, head, tail, wc, uniq, find

## API

| Export | Description |
|--------|-------------|
| `HermeticShell` | Shell interpreter class |
| `createShell(fs, options?)` | Factory function |
| `expandGlob(pattern, cwd, fs)` | Expand glob patterns against filesystem |
