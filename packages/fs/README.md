# @hermetic/fs

Virtual filesystem with OPFS, IndexedDB, and memory backends plus file watching support.

## Install

```bash
npm install @hermetic/fs
```

## Usage

```ts
import { createFS, MemoryFS } from "@hermetic/fs";

// Auto-detect best backend (OPFS > IndexedDB > memory)
const fs = await createFS();

// Or use a specific backend
const memfs = new MemoryFS();
await memfs.writeFile("/hello.txt", "Hello!");
const data = await memfs.readFile("/hello.txt", "utf-8"); // "Hello!"

// Watch for changes
const unwatch = memfs.watch("/", (event) => {
  console.log(event.type, event.path);
});
```

## API

| Export | Description |
|--------|-------------|
| `createFS(options?)` | Create FS with auto-detected backend |
| `MemoryFS` | In-memory filesystem |
| `OPFSFS` | Origin Private File System backend |
| `IndexedDBFS` | IndexedDB-backed filesystem |
| `createWatcher` | Polling-based file watcher |
| `createNativeWatcher` | FileSystemObserver watcher (Chrome 129+) |
| `createDebouncedWatcher` | Debounced watcher wrapper |
| `hasFileSystemObserver` | Feature detection |
