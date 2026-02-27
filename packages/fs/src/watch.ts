// @hermetic/fs — File watching utilities
//
// Uses FileSystemObserver when available, falls back to polling at 500ms.

import type { WatchCallback, WatchEvent, WatchEventType } from "./types.js";

/** Check if FileSystemObserver is available (Chrome 129+) */
export function hasFileSystemObserver(): boolean {
  return typeof globalThis !== "undefined" && "FileSystemObserver" in globalThis;
}

/**
 * Create a file watcher using the best available mechanism.
 * Returns an unsubscribe function.
 */
export function createWatcher(
  getEntries: () => Promise<Map<string, { mtime: number; size: number }>>,
  callback: WatchCallback,
  intervalMs = 500,
): () => void {
  // Polling fallback
  let snapshot = new Map<string, string>();
  let running = true;

  const poll = async () => {
    if (!running) return;
    try {
      const current = await getEntries();
      const currentKeys = new Set(current.keys());
      const prevKeys = new Set(snapshot.keys());

      // Check for new or modified entries
      for (const [path, info] of current) {
        const key = `${info.mtime}:${info.size}`;
        const prev = snapshot.get(path);
        if (prev === undefined) {
          if (snapshot.size > 0) {
            // Only emit create if we had a previous snapshot
            callback({ type: "create", path });
          }
        } else if (prev !== key) {
          callback({ type: "modify", path });
        }
      }

      // Check for deleted entries
      for (const path of prevKeys) {
        if (!currentKeys.has(path)) {
          callback({ type: "delete", path });
        }
      }

      // Update snapshot
      snapshot = new Map();
      for (const [path, info] of current) {
        snapshot.set(path, `${info.mtime}:${info.size}`);
      }
    } catch {
      // Ignore poll errors
    }
  };

  const interval = setInterval(poll, intervalMs);
  // Initial snapshot
  poll();

  return () => {
    running = false;
    clearInterval(interval);
  };
}
