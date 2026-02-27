// @hermetic/fs — Public API

export type {
  FileStat,
  WriteOptions,
  MkdirOptions,
  RmdirOptions,
  WatchEvent,
  WatchEventType,
  WatchCallback,
  FSOptions,
  HermeticFS,
} from "./types.js";

export { MemoryFS } from "./backends/memory.js";
export { OPFSFS } from "./backends/opfs.js";
export { IndexedDBFS } from "./backends/indexeddb.js";
export { createWatcher, createNativeWatcher, createDebouncedWatcher, hasFileSystemObserver } from "./watch.js";

import type { HermeticFS, FSOptions } from "./types.js";
import { MemoryFS } from "./backends/memory.js";
import { OPFSFS } from "./backends/opfs.js";
import { IndexedDBFS } from "./backends/indexeddb.js";

function detectBestBackend(): "opfs" | "indexeddb" | "memory" {
  if (typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage) {
    return "opfs";
  }
  if (typeof indexedDB !== "undefined") {
    return "indexeddb";
  }
  return "memory";
}

/**
 * Create a HermeticFS instance.
 * Auto-selects OPFS > IndexedDB > memory.
 */
export async function createFS(options: FSOptions = {}): Promise<HermeticFS> {
  const backend = options.backend ?? detectBestBackend();
  switch (backend) {
    case "memory":
      return new MemoryFS();
    case "opfs":
      return OPFSFS.create();
    case "indexeddb":
      return IndexedDBFS.create();
  }
}
