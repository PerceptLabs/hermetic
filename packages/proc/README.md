# @hermetic/proc

Process model using Web Workers with resource limits, timeouts, and Node.js emulation.

## Install

```bash
npm install @hermetic/proc
```

## Usage

```ts
import { createProc } from "@hermetic/proc";

const proc = createProc(fs);
const handle = proc.spawn("node", ["script.js"], { timeout: 10_000 });
const exitCode = await handle.wait();
```

## API

| Export | Description |
|--------|-------------|
| `HermeticProc` | Process manager class (MAX_CONCURRENT=10, MAX_PROCESSES=50) |
| `createProc(fs?)` | Factory function accepting optional filesystem |

### Types

| Type | Description |
|------|-------------|
| `ProcessHandle` | Handle with stdout/stderr streams, wait(), kill() |
| `ProcessRecord` | Process table entry (pid, status, exitCode) |
| `SpawnOptions` | Options: cwd, env, stdin, timeout |
