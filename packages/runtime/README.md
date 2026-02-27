# @hermetic/runtime

Facade that wires all Hermetic subsystems into a single runtime instance.

## Install

```bash
npm install @hermetic/runtime
```

## Usage

```ts
import { Hermetic } from "@hermetic/runtime";

const runtime = await Hermetic.create({ cwd: "/", env: { HOME: "/home" } });

// Access all subsystems
await runtime.fs.writeFile("/app.js", 'console.log("hello")');
const result = await runtime.shell.exec("node /app.js");
console.log(result.stdout); // "hello\n"

// Clean up everything
runtime.dispose();
```

## API

| Export | Description |
|--------|-------------|
| `Hermetic` | Main runtime class with fs, vm, proc, pm, shell |
| `Hermetic.create(options?)` | Async factory (auto-detects best FS backend) |
| `runtime.dispose()` | Clean up all subsystems |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `fs` | `HermeticFS` | Virtual filesystem |
| `vm` | `HermeticVM` | Capability-based VM |
| `proc` | `HermeticProc` | Process manager |
| `pm` | `HermeticPM` | Package manager |
| `shell` | `HermeticShell` | Shell interpreter |
