# @hermetic/core

Core utilities providing the messaging protocol, disposable resource management, path operations, and channel-based communication for the Hermetic platform.

## Install

```bash
npm install @hermetic/core
```

## Basic Usage

```ts
import { HermeticChannel, DisposableStore, normalizePath, joinPath, dirname } from "@hermetic/core";

// Create a communication channel
const { port1, port2 } = new MessageChannel();
const channel = new HermeticChannel(port1);
const result = await channel.call("fs", "readFile", ["/app.js"]);

// Manage disposable resources
const store = new DisposableStore();
store.add({ dispose: () => console.log("cleaned up") });
store.dispose();

// Path utilities
const full = joinPath("/home", "user", "file.txt");
const dir = dirname(full);   // "/home/user"
const ext = extname(full);   // ".txt"
const mime = guessMimeType("style.css"); // "text/css"
```

## API Reference

### Classes

| Export | Description |
|---|---|
| `HermeticChannel` | Bidirectional RPC channel over `MessagePort` |
| `DisposableStore` | Collects disposable resources and disposes them together |

### Functions

| Export | Description |
|---|---|
| `normalizePath(path)` | Normalize a file path |
| `joinPath(...segments)` | Join path segments |
| `dirname(path)` | Get directory name from a path |
| `basename(path)` | Get file name from a path |
| `extname(path)` | Get file extension from a path |
| `resolvePath(...segments)` | Resolve path segments to an absolute path |
| `guessMimeType(path)` | Guess MIME type from a file extension |
| `isHermeticMessage(value)` | Check if a value is a valid Hermetic protocol message |
| `serializeError(error)` | Serialize an Error into a transferable object |
| `deserializeError(data)` | Deserialize a transferable object back into an Error |

### Types

| Type | Description |
|---|---|
| `Disposable` | An object with a `dispose()` method |
| `RequestMessage` | A request in the Hermetic messaging protocol |
| `ResponseMessage` | A response in the Hermetic messaging protocol |
| `NotificationMessage` | A one-way notification message |
| `HermeticMessage` | Union of all message types |
