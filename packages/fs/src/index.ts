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
export { createWatcher, hasFileSystemObserver } from "./watch.js";

import type { HermeticFS, FSOptions } from "./types.js";
import { MemoryFS } from "./backends/memory.js";
import { OPFSFS } from "./backends/opfs.js";

function supportsOPFS(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    "getDirectory" in navigator.storage
  );
}

/**
 * Create a HermeticFS instance.
 * Auto-selects OPFS in browser, memory in Node/test.
 */
export async function createFS(options: FSOptions = {}): Promise<HermeticFS> {
  const backend = options.backend ?? (supportsOPFS() ? "opfs" : "memory");
  switch (backend) {
    case "memory":
      return new MemoryFS();
    case "opfs":
      return OPFSFS.create();
    case "indexeddb":
      throw new Error('IndexedDB backend not yet implemented. Use "memory" or "opfs".');
  }
}
