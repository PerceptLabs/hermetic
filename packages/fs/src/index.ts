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

import type { HermeticFS, FSOptions } from "./types.js";
import { MemoryFS } from "./backends/memory.js";

/**
 * Create a HermeticFS instance.
 * For Step 2 (memory backend only), always returns MemoryFS.
 * OPFS and IndexedDB backends will be added in Step 3.
 */
export function createFS(options: FSOptions = {}): HermeticFS {
  const backend = options.backend ?? "memory";
  switch (backend) {
    case "memory":
      return new MemoryFS();
    case "opfs":
    case "indexeddb":
      throw new Error(`Backend "${backend}" not yet implemented. Use "memory" for now.`);
  }
}
